import { createHash, randomBytes } from "node:crypto";
import {
  ChangeCredentialsInput, CreateUserInput, LoginInput, PinLoginInput, ROLE_PERMISSIONS, SetupInput, UpdateUserInput,
  type AuthStatus, type Role, type SessionUser, type UserSummary, type UserTile,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { hashSecret, verifySecret } from "../../core/passwords.js";

/** Sessions end after 30 minutes without activity, and after 12 hours in any case (one shift). */
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 12 * 60 * 60_000;
/** 5 wrong passwords/PINs lock the account for 5 minutes, which slows guessing a 4-digit PIN to a crawl. */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

interface UserRow {
  id: string; username: string; display_name: string; role: Role; password_hash: string; pin_hash: string | null;
  must_change_password: boolean; active: boolean; failed_attempts: number; locked_until: string | null; last_login_at: string | null;
}
const USER_COLS = `id, username, display_name, role, password_hash, pin_hash, must_change_password, active, failed_attempts, locked_until, last_login_at`;

const toSessionUser = (u: UserRow): SessionUser => ({
  id: u.id, username: u.username, displayName: u.display_name, role: u.role, permissions: [...ROLE_PERMISSIONS[u.role]],
  hasPin: !!u.pin_hash, mustChangePassword: u.must_change_password,
});
const toSummary = (u: UserRow): UserSummary => ({
  id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active, hasPin: !!u.pin_hash,
  mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at, lockedUntil: u.locked_until,
});

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionContext {
  user: SessionUser;
  tokenHash: string;
}

// ───────────────────────── Sessions ─────────────────────────

async function createSession(q: Queryable, userId: string, terminal: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q.query("delete from core.session where expires_at < $1 or last_seen_at < $2", [now.toISOString(), new Date(now.getTime() - SESSION_IDLE_MS).toISOString()]);
  await q.query("insert into core.session (token_hash, user_id, terminal, created_at, last_seen_at, expires_at) values ($1,$2,$3,$4,$4,$5)", [
    tokenHash(token), userId, terminal, now.toISOString(), new Date(now.getTime() + SESSION_MAX_MS).toISOString(),
  ]);
  return token;
}

/** Resolve a session token to its user, or null if it is unknown, expired, idle too long, or the user was disabled. */
export async function resolveSession(db: Queryable, token: string | undefined, now = new Date()): Promise<SessionContext | null> {
  if (!token) return null;
  const h = tokenHash(token);
  const { rows } = await db.query<UserRow & { expires_at: string; last_seen_at: string }>(
    `select ${USER_COLS.split(", ").map((c) => "u." + c).join(", ")}, s.expires_at, s.last_seen_at
       from core.session s join core.app_user u on u.id = s.user_id
      where s.token_hash = $1`,
    [h],
  );
  const r = rows[0];
  if (!r) return null;
  const t = now.getTime();
  if (!r.active || Date.parse(r.expires_at) <= t || Date.parse(r.last_seen_at) + SESSION_IDLE_MS <= t) {
    await db.query("delete from core.session where token_hash = $1", [h]);
    return null;
  }
  // Refresh idle time at most once a minute, so normal use doesn't write on every request.
  if (t - Date.parse(r.last_seen_at) > 60_000) {
    await db.query("update core.session set last_seen_at = $2 where token_hash = $1", [h, now.toISOString()]);
  }
  return { user: toSessionUser(r), tokenHash: h };
}

export async function logout(db: Db, ctx: SessionContext, terminal: string): Promise<void> {
  await db.tx(async (q) => {
    await q.query("delete from core.session where token_hash = $1", [ctx.tokenHash]);
    await audit(q, { user: ctx.user.username, terminal }, "auth.logout", "user", ctx.user.id);
  });
}

// ───────────────────────── Status / setup ─────────────────────────

export async function needsSetup(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from core.app_user");
  return (rows[0]?.n ?? 0) === 0;
}

export async function authStatus(db: Queryable, ctx: SessionContext | null): Promise<AuthStatus> {
  return { needsSetup: await needsSetup(db), user: ctx?.user ?? null };
}

/** First run only: create the administrator and sign them in. Refused once any user exists. */
export async function setup(db: Db, raw: unknown, terminal: string, now = new Date()): Promise<{ token: string; user: SessionUser }> {
  const v = SetupInput.parse(raw);
  const passwordHash = await hashSecret(v.password);
  const pinHash = v.pin ? await hashSecret(v.pin) : null;
  return db.tx(async (q) => {
    // Lock the user table so two setup attempts at once cannot both succeed.
    await q.query("lock table core.app_user in exclusive mode");
    if (!(await needsSetup(q))) throw new AppError(409, "already_set_up", "Ojas is already set up. Sign in instead.");
    const id = uuidv7();
    await q.query(
      `insert into core.app_user (id, username, display_name, role, password_hash, pin_hash, last_login_at, created_by, updated_by)
       values ($1,$2,$3,'ADMIN',$4,$5,$6,$2,$2)`,
      [id, v.username, v.displayName, passwordHash, pinHash, now.toISOString()],
    );
    await audit(q, { user: v.username, terminal }, "auth.setup", "user", id, { username: v.username });
    const token = await createSession(q, id, terminal, now);
    return { token, user: toSessionUser((await getUserRow(q, id))!) };
  });
}

// ───────────────────────── Sign-in ─────────────────────────

async function getUserRow(q: Queryable, id: string): Promise<UserRow | undefined> {
  return (await q.query<UserRow>(`select ${USER_COLS} from core.app_user where id = $1`, [id])).rows[0];
}

const lockedMessage = (until: string) =>
  `Too many wrong attempts. Try again after ${new Date(until).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}, or ask an administrator.`;

/** Shared by password and PIN sign-in: lockout, failure counting, audit, session creation. */
async function signIn(
  db: Db, user: UserRow | undefined, secretOk: (u: UserRow | undefined) => Promise<boolean>, method: string, attempted: string, terminal: string, now: Date,
): Promise<{ token: string; user: SessionUser }> {
  if (user?.locked_until && Date.parse(user.locked_until) > now.getTime()) {
    throw new AppError(423, "account_locked", lockedMessage(user.locked_until));
  }
  const ok = await secretOk(user);
  if (!ok || !user || !user.active) {
    await db.tx(async (q) => {
      if (user) {
        const failures = user.failed_attempts + 1;
        const lockUntil = failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MS).toISOString() : null;
        await q.query("update core.app_user set failed_attempts = $2, locked_until = $3 where id = $1", [user.id, lockUntil ? 0 : failures, lockUntil]);
      }
      await audit(q, { user: attempted, terminal }, `auth.${method}_failed`, "user", user?.id ?? "-", { reason: !user ? "unknown_user" : !user.active ? "inactive" : "bad_secret" });
    });
    throw new AppError(401, "invalid_credentials", method === "pin" ? "Wrong PIN" : "Wrong username or password");
  }
  return db.tx(async (q) => {
    await q.query("update core.app_user set failed_attempts = 0, locked_until = null, last_login_at = $2 where id = $1", [user.id, now.toISOString()]);
    await audit(q, { user: user.username, terminal }, `auth.${method}_login`, "user", user.id);
    const token = await createSession(q, user.id, terminal, now);
    return { token, user: toSessionUser(user) };
  });
}

export async function login(db: Db, raw: unknown, terminal: string, now = new Date()) {
  const v = LoginInput.parse(raw);
  const user = (await db.query<UserRow>(`select ${USER_COLS} from core.app_user where username = $1`, [v.username])).rows[0];
  return signIn(db, user, (u) => verifySecret(v.password, u?.password_hash), "password", v.username, terminal, now);
}

/** Quick sign-in on a shared desk: pick your name, type your PIN. */
export async function pinLogin(db: Db, raw: unknown, terminal: string, now = new Date()) {
  const v = PinLoginInput.parse(raw);
  const user = await getUserRow(db, v.userId);
  if (user && !user.pin_hash) throw new AppError(400, "no_pin", "No PIN set for this user. Sign in with your password.");
  // A user who must change their password has to do it with the password, not a PIN.
  if (user?.must_change_password) throw new AppError(400, "password_change_required", "Sign in with your password to set a new one.");
  return signIn(db, user, (u) => verifySecret(v.pin, u?.pin_hash), "pin", user?.username ?? v.userId, terminal, now);
}

/** Names for the lock screen tiles. Only for IDs this terminal already knows, so the staff list isn't exposed. */
export async function tiles(db: Queryable, ids: string[]): Promise<UserTile[]> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 12);
  if (!valid.length) return [];
  const { rows } = await db.query<{ id: string; display_name: string; role: Role; has_pin: boolean }>(
    "select id, display_name, role, pin_hash is not null as has_pin from core.app_user where id = any($1::uuid[]) and active",
    [valid],
  );
  const order = new Map(valid.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map((r) => ({ id: r.id, displayName: r.display_name, role: r.role, hasPin: r.has_pin }));
}

// ───────────────────────── My account ─────────────────────────

export async function changeCredentials(db: Db, ctx: SessionContext, raw: unknown, terminal: string): Promise<SessionUser> {
  const v = ChangeCredentialsInput.parse(raw);
  if (!v.newPassword && !v.newPin) throw new AppError(400, "nothing_to_change", "Enter a new password or PIN");
  const user = (await getUserRow(db, ctx.user.id))!;
  if (!(await verifySecret(v.currentPassword, user.password_hash))) {
    throw new AppError(400, "validation_failed", "Current password is wrong", { fields: { currentPassword: "Current password is wrong" } });
  }
  if (user.must_change_password && !v.newPassword) throw new AppError(400, "validation_failed", "Choose a new password", { fields: { newPassword: "Choose a new password" } });
  if (v.newPassword && v.newPassword === v.currentPassword) {
    throw new AppError(400, "validation_failed", "New password must be different", { fields: { newPassword: "Must be different from the current one" } });
  }
  const pwHash = v.newPassword ? await hashSecret(v.newPassword) : null;
  const pinHash = v.newPin ? await hashSecret(v.newPin) : null;
  return db.tx(async (q) => {
    await q.query(
      `update core.app_user set
         password_hash = coalesce($2, password_hash),
         must_change_password = case when $2::text is null then must_change_password else false end,
         pin_hash = coalesce($3, pin_hash),
         updated_at = now(), updated_by = $4, row_version = row_version + 1
       where id = $1`,
      [user.id, pwHash, pinHash, user.username],
    );
    // A new password ends this user's sessions on every other desk.
    if (pwHash) await q.query("delete from core.session where user_id = $1 and token_hash <> $2", [user.id, ctx.tokenHash]);
    await audit(q, { user: user.username, terminal }, "user.change_credentials", "user", user.id, { password: !!pwHash, pin: !!pinHash });
    return toSessionUser((await getUserRow(q, user.id))!);
  });
}

// ───────────────────────── User administration ─────────────────────────

export async function listUsers(db: Queryable): Promise<UserSummary[]> {
  const { rows } = await db.query<UserRow>(`select ${USER_COLS} from core.app_user order by active desc, display_name`);
  return rows.map(toSummary);
}

export async function createUser(db: Db, actor: Actor, raw: unknown): Promise<UserSummary> {
  const v = CreateUserInput.parse(raw);
  const pwHash = await hashSecret(v.password);
  try {
    return await db.tx(async (q) => {
      const id = uuidv7();
      await q.query(
        `insert into core.app_user (id, username, display_name, role, password_hash, must_change_password, created_by, updated_by)
         values ($1,$2,$3,$4,$5,true,$6,$6)`,
        [id, v.username, v.displayName, v.role, pwHash, actor.user],
      );
      await audit(q, actor, "user.create", "user", id, { username: v.username, role: v.role });
      return toSummary((await getUserRow(q, id))!);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "validation_failed", "That username is taken", { fields: { username: "That username is taken" } });
    throw e;
  }
}

export async function updateUser(db: Db, actor: Actor, actorId: string, id: string, raw: unknown): Promise<UserSummary> {
  const v = UpdateUserInput.parse(raw);
  const pwHash = v.resetPassword ? await hashSecret(v.resetPassword) : null;
  return db.tx(async (q) => {
    await q.query("lock table core.app_user in share row exclusive mode");
    const user = await getUserRow(q, id);
    if (!user) throw new AppError(404, "user_not_found", "User not found");
    if (id === actorId && (v.active === false || (v.role && v.role !== user.role))) {
      throw new AppError(422, "cannot_change_self", "You can't deactivate yourself or change your own role. Ask another administrator.");
    }
    const losesAdmin = user.role === "ADMIN" && user.active && (v.active === false || (v.role !== undefined && v.role !== "ADMIN"));
    if (losesAdmin) {
      const { rows } = await q.query<{ n: number }>("select count(*)::int as n from core.app_user where role = 'ADMIN' and active");
      if ((rows[0]?.n ?? 0) <= 1) throw new AppError(422, "last_admin", "There must always be at least one active administrator.");
    }
    await q.query(
      `update core.app_user set
         display_name = coalesce($2, display_name),
         role = coalesce($3, role),
         active = coalesce($4, active),
         password_hash = coalesce($5, password_hash),
         must_change_password = case when $5::text is null then must_change_password else true end,
         failed_attempts = case when $5::text is null then failed_attempts else 0 end,
         locked_until = case when $5::text is null then locked_until else null end,
         pin_hash = case when $6 then null else pin_hash end,
         updated_at = now(), updated_by = $7, row_version = row_version + 1
       where id = $1`,
      [id, v.displayName ?? null, v.role ?? null, v.active ?? null, pwHash, v.clearPin ?? false, actor.user],
    );
    // Deactivation, role change or password reset take effect immediately on every desk.
    if (v.active === false || v.role || pwHash) await q.query("delete from core.session where user_id = $1", [id]);
    await audit(q, actor, "user.update", "user", id, {
      displayName: v.displayName, role: v.role, active: v.active, passwordReset: !!pwHash, pinCleared: v.clearPin || undefined,
    });
    return toSummary((await getUserRow(q, id))!);
  });
}
