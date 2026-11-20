import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { BackupFile, BackupRun, BackupStatus } from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { ADMIN, Client, makeApp, setupAdmin } from "./helpers.js";

// A clock the tests move forward, so file names (to the second) and schedules are predictable.
let clock = new Date(2026, 10, 20, 9, 0, 0);
const tick = (ms = 60_000) => (clock = new Date(clock.getTime() + ms));
const HOUR = 3_600_000;

const root = mkdtempSync(join(tmpdir(), "ojas-backup-test-"));
const primary = join(root, "main");
const usb = join(root, "usb");
const PASSWORD = "backup-pass-1";

let db: Db;
let app: FastifyInstance;
let admin: Client;
const put = (url: string, payload: object) => admin.req({ method: "PUT", url, payload });
const status = async () => (await admin.get("/api/backups/status")).json() as BackupStatus;
const backupNow = async () => {
  tick();
  const res = await admin.post("/api/backups/run");
  expect(res.statusCode).toBe(200);
  return res.json() as BackupRun;
};
const backupFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".ojasbak")).sort();

beforeAll(async () => {
  ({ db, app } = await makeApp(() => clock));
  admin = await setupAdmin(app);
});
afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("backups", () => {
  it("start switched off, and say so loudly", async () => {
    const s = await status();
    expect(s).toMatchObject({ supported: true, configured: false, lastSuccess: null });
    expect(s.warnings.map((w) => [w.level, w.code])).toContainEqual(["danger", "not_configured"]);
    expect((await admin.post("/api/backups/run")).statusCode).toBe(409);
  });

  it("need a password and full folder paths, and check the folders are writable", async () => {
    expect((await put("/api/backups/config", { primaryDir: primary })).json().details.fields).toHaveProperty("password");
    expect((await put("/api/backups/config", { password: PASSWORD, primaryDir: "backups" })).json().details.fields).toHaveProperty("primaryDir");
    const blocked = join(root, "not-a-folder");
    writeFileSync(blocked, "x");
    const res = await put("/api/backups/config", { password: PASSWORD, primaryDir: primary, secondaryDir: join(blocked, "sub") });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.fields).toHaveProperty("secondaryDir");
  });

  it("are set up with a main folder and a second copy (USB)", async () => {
    const res = await put("/api/backups/config", { password: PASSWORD, primaryDir: primary, secondaryDir: usb, intervalHours: 4, keepCount: 3 });
    expect(res.statusCode).toBe(200);
    const s = res.json() as BackupStatus;
    expect(s.configured).toBe(true);
    expect(s.warnings.map((w) => w.code)).toEqual(["never_succeeded"]);
    // The audit records the change but never the password or key.
    const { rows } = await db.query<{ data: unknown }>("select data from core.audit_event where action = 'backup.configure'");
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(rows[0]!.data).toMatchObject({ passwordChanged: true });
  });

  it("write an encrypted, verified file to both folders", async () => {
    const run = await backupNow();
    expect(run).toMatchObject({ ok: true, reason: "manual", actor: "admin" });
    expect(run.copies).toEqual([{ dir: primary, ok: true }, { dir: usb, ok: true }]);
    expect(backupFiles(primary)).toEqual([run.fileName]);
    expect(backupFiles(usb)).toEqual([run.fileName]);
    const file = readFileSync(join(primary, run.fileName!));
    expect(file.subarray(0, 8).toString()).toBe("OJASBAK1");
    expect(file.toString("latin1")).not.toContain("Asha Admin"); // user names live inside the encrypted part
    expect(readdirSync(primary).some((n) => n.endsWith(".partial"))).toBe(false);
    const s = await status();
    expect(s.lastSuccess?.id).toBe(run.id);
    expect(s.warnings).toEqual([]);
  });

  it("list backups from their header, without the password", async () => {
    const files = (await admin.get("/api/backups/files")).json() as BackupFile[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ facilityName: "Ojas Demo Clinic", reason: "manual", needsPassword: false });
  });

  it("still succeed when the USB copy fails, but warn", async () => {
    rmSync(usb, { recursive: true, force: true });
    writeFileSync(usb, "the drive letter now points at a file"); // makes the folder unusable
    const run = await backupNow();
    expect(run.ok).toBe(true);
    expect(run.copies[1]).toMatchObject({ dir: usb, ok: false });
    expect((await status()).warnings.map((w) => w.code)).toEqual(["copy_failed"]);
    rmSync(usb, { force: true });
  });

  it("keep only the newest N files", async () => {
    for (let i = 0; i < 3; i++) await backupNow();
    expect(backupFiles(primary)).toHaveLength(3);
    expect(backupFiles(usb)).toHaveLength(3);
  });

  it("run on schedule only when due", async () => {
    expect(await app.backups.runIfDue()).toBeNull();
    tick(4 * HOUR);
    const run = await app.backups.runIfDue();
    expect(run).toMatchObject({ ok: true, reason: "scheduled", actor: "system" });
    expect(await app.backups.runIfDue()).toBeNull();
  });

  it("warn when the newest backup is more than a day old", async () => {
    tick(25 * HOUR);
    // A day later the admin's session has timed out (30 min idle), as it should: sign in again.
    expect((await admin.get("/api/backups/status")).statusCode).toBe(401);
    await admin.post("/api/auth/login", { username: ADMIN.username, password: ADMIN.password });
    expect((await status()).warnings).toContainEqual(expect.objectContaining({ level: "danger", code: "stale" }));
  });

  it("are for administrators only", async () => {
    const rx = new Client(app);
    expect((await rx.get("/api/backups/status")).statusCode).toBe(401);
    expect((await rx.get("/api/setup/backups")).statusCode).toBe(403); // setup routes close once set up
  });

  describe("restore", () => {
    let target: BackupFile;

    it("needs typed confirmation", async () => {
      target = ((await admin.get("/api/backups/files")).json() as BackupFile[])[0]!;
      const res = await admin.post("/api/backups/restore", { path: target.path, confirm: "yes" });
      expect(res.statusCode).toBe(400);
    });

    it("brings the data back to the backup, after a safety backup, and signs everyone out", async () => {
      const added = await admin.post("/api/patients", { name: "After Backup", sex: "F", phone: "9840099999", ageYears: 30 });
      expect(added.statusCode).toBe(201);
      const runsBefore = (await admin.get("/api/backups/runs")).json().length;
      tick();

      const res = await admin.post("/api/backups/restore", { path: target.path, confirm: "RESTORE" });
      expect(res.statusCode).toBe(200);
      expect(res.json().safetyBackup).toMatch(/pre-restore\.ojasbak$/);

      expect((await admin.get("/api/patients/search?q=After")).statusCode).toBe(401); // signed out
      await admin.post("/api/auth/login", { username: ADMIN.username, password: ADMIN.password });
      expect((await admin.get("/api/patients/search?q=After")).json()).toEqual([]);

      // This install's backup history and settings survive the restore of an older database.
      const runs = (await admin.get("/api/backups/runs")).json() as BackupRun[];
      expect(runs.length).toBe(runsBefore + 1);
      expect(runs[0]!.reason).toBe("pre-restore");
      expect((await status()).secondaryDir).toBe(usb);
      expect((await admin.get("/api/audit/verify")).json().ok).toBe(true);
      const { rows } = await db.query("select 1 from core.audit_event where action = 'system.restore'");
      expect(rows).toHaveLength(1);
    });

    it("undoes itself with the safety backup", async () => {
      const files = (await admin.get("/api/backups/files")).json() as BackupFile[];
      const safety = files.find((f) => f.reason === "pre-restore")!;
      tick();
      expect((await admin.post("/api/backups/restore", { path: safety.path, confirm: "RESTORE" })).statusCode).toBe(200);
      await admin.post("/api/auth/login", { username: ADMIN.username, password: ADMIN.password });
      expect((await admin.get("/api/patients/search?q=After")).json()).toHaveLength(1);
    });

    it("keeps older files restorable here after the password changes", async () => {
      expect((await put("/api/backups/config", { password: "new-backup-pass", primaryDir: primary, secondaryDir: usb, keepCount: 3 })).statusCode).toBe(200);
      const files = (await admin.get("/api/backups/files")).json() as BackupFile[];
      expect(files.every((f) => !f.needsPassword)).toBe(true);
    });
  });

  describe("disaster recovery on a new PC", () => {
    let fresh: FastifyInstance;
    let freshDb: Db;
    let file: BackupFile;
    const anon = () => new Client(fresh);

    beforeAll(async () => {
      ({ db: freshDb, app: fresh } = await makeApp(() => clock, { demo: false }));
    });
    afterAll(async () => {
      await fresh.close();
      await freshDb.close();
    });

    it("lists backups from the USB folder before any account exists", async () => {
      const res = await anon().get(`/api/setup/backups?folder=${encodeURIComponent(usb)}`);
      expect(res.statusCode).toBe(200);
      file = (res.json() as BackupFile[])[0]!;
      expect(file.needsPassword).toBe(true);
    });

    it("asks for the backup password and rejects a wrong one", async () => {
      expect((await anon().post("/api/setup/restore", { path: file.path, confirm: "RESTORE" })).json().code).toBe("password_required");
      expect((await anon().post("/api/setup/restore", { path: file.path, confirm: "RESTORE", password: "wrong-password" })).json().code).toBe("wrong_password");
    });

    it("restores everything, then the old accounts sign in and setup closes", async () => {
      const res = await anon().post("/api/setup/restore", { path: file.path, confirm: "RESTORE", password: PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(res.json().safetyBackup).toBeNull(); // nothing to protect on a blank install
      const c = anon();
      expect((await c.post("/api/auth/login", { username: ADMIN.username, password: ADMIN.password })).statusCode).toBe(200);
      expect((await c.get("/api/facility")).json()).toMatchObject({ name: "Ojas Demo Clinic", setupCompleted: true });
      expect((await anon().get("/api/setup/backups")).statusCode).toBe(403);
      // The key that worked is remembered, so this PC can restore that series without the password.
      const files = (await c.get(`/api/backups/files?folder=${encodeURIComponent(usb)}`)).json() as BackupFile[];
      expect(files.find((f) => f.fileName === file.fileName)?.needsPassword).toBe(false);
    });
  });
});
