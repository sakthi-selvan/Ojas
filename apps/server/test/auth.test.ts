import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { ADMIN, Client, makeApp, setupAdmin, userWithRole } from "./helpers.js";

let db: Db;
let app: FastifyInstance;
let anon: () => Client;
let admin: Client;
let clock = new Date(2026, 10, 20, 10, 0);
const now = () => clock;

beforeAll(async () => {
  ({ db, app, anon } = await makeApp(now));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("first-run setup", () => {
  it("reports that setup is needed and blocks the API until then", async () => {
    expect((await anon().get("/api/auth/status")).json()).toEqual({ needsSetup: true, user: null });
    expect((await anon().get("/api/patients/search?q=ra")).statusCode).toBe(401);
  });

  it("validates the administrator's details", async () => {
    const res = await anon().post("/api/auth/setup", { displayName: "A", username: "x", password: "short" });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().details.fields)).toEqual(expect.arrayContaining(["displayName", "username", "password"]));
  });

  it("creates the admin, signs them in, and can't be run twice", async () => {
    admin = await setupAdmin(app);
    const me = (await admin.get("/api/auth/status")).json();
    expect(me).toMatchObject({ needsSetup: false, user: { username: "admin", role: "ADMIN" } });
    expect(me.user.permissions).toContain("users.manage");
    expect((await anon().post("/api/auth/setup", { ...ADMIN, username: "admin2" })).json().code).toBe("already_set_up");
  });
});

describe("password sign-in", () => {
  it("issues an HttpOnly, SameSite=Strict session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-ojas-terminal": "T1" }, payload: { username: "ADMIN", password: ADMIN.password } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((k) => k.name === "ojas_session")!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Strict");
    expect(c.path).toBe("/api");
  });

  it("gives the same message for unknown users and wrong passwords", async () => {
    const a = await anon().post("/api/auth/login", { username: "nobody", password: "whatever-123" });
    const b = await anon().post("/api/auth/login", { username: "admin", password: "wrong-password" });
    expect(a.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it("rejects state-changing requests that don't come from the Ojas app", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: ADMIN.password } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("missing_client_header");
  });

  it("locks the account after 5 wrong attempts, then unlocks after 5 minutes", async () => {
    const { client: rx } = await userWithRole(app, admin, "RECEPTION", "lockme");
    for (let i = 0; i < 5; i++) await anon().post("/api/auth/login", { username: "lockme", password: "nope-nope-nope" });
    const locked = await anon().post("/api/auth/login", { username: "lockme", password: "real-pass-123" });
    expect(locked.statusCode).toBe(423);
    clock = new Date(clock.getTime() + 5 * 60_000 + 1000);
    expect((await anon().post("/api/auth/login", { username: "lockme", password: "real-pass-123" })).statusCode).toBe(200);
    void rx;
  });

  it("logout ends the session", async () => {
    const c = anon();
    await c.post("/api/auth/login", { username: "admin", password: ADMIN.password });
    const cookie = c.cookie;
    expect((await c.post("/api/auth/logout")).statusCode).toBe(200);
    expect((await new Client(app, cookie).get("/api/queue")).statusCode).toBe(401);
  });

  it("logout works exactly as the browser sends it: JSON content-type, empty body", async () => {
    const c = anon();
    await c.post("/api/auth/login", { username: "admin", password: ADMIN.password });
    const cookie = c.cookie;
    const res = await c.req({ method: "POST", url: "/api/auth/logout", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
    expect((await new Client(app, cookie).get("/api/queue")).statusCode).toBe(401);
  });

  it("expires sessions after 30 minutes idle", async () => {
    const c = anon();
    await c.post("/api/auth/login", { username: "admin", password: ADMIN.password });
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect((await c.get("/api/queue")).statusCode).toBe(401);
    // Re-sign in the shared admin for the remaining tests.
    await admin.post("/api/auth/login", { username: "admin", password: ADMIN.password });
  });
});

describe("temporary passwords and PINs", () => {
  it("forces a new user to replace the temporary password before using the app", async () => {
    await admin.post("/api/users", { displayName: "Ravi Desk", username: "ravi", role: "RECEPTION", password: "temp-pass-1" });
    const c = anon();
    const me = (await c.post("/api/auth/login", { username: "ravi", password: "temp-pass-1" })).json();
    expect(me.mustChangePassword).toBe(true);
    expect((await c.get("/api/queue")).json().code).toBe("password_change_required");
    const same = await c.post("/api/auth/credentials", { currentPassword: "temp-pass-1", newPassword: "temp-pass-1" });
    expect(same.json().details.fields).toHaveProperty("newPassword");
    const ok = await c.post("/api/auth/credentials", { currentPassword: "temp-pass-1", newPassword: "ravi-secret-9", newPin: "4826" });
    expect(ok.json()).toMatchObject({ mustChangePassword: false, hasPin: true });
    expect((await c.get("/api/queue")).statusCode).toBe(200);
  });

  it("rejects easy PINs", async () => {
    const res = await admin.post("/api/auth/credentials", { currentPassword: ADMIN.password, newPin: "1234" });
    expect(res.json().details.fields).toHaveProperty("newPin");
  });

  it("signs in by name tile + PIN, and only shows tiles for known IDs", async () => {
    const users = (await admin.get("/api/users")).json() as { id: string; username: string }[];
    const ravi = users.find((u) => u.username === "ravi")!;
    expect((await anon().post("/api/auth/tiles", { ids: [] })).json()).toEqual([]);
    const tiles = (await anon().post("/api/auth/tiles", { ids: [ravi.id, randomUUID()] })).json();
    expect(tiles).toEqual([{ id: ravi.id, displayName: "Ravi Desk", role: "RECEPTION", hasPin: true }]);
    expect((await anon().post("/api/auth/pin", { userId: ravi.id, pin: "0001" })).json().message).toBe("Wrong PIN");
    const c = anon();
    expect((await c.post("/api/auth/pin", { userId: ravi.id, pin: "4826" })).statusCode).toBe(200);
    expect((await c.get("/api/queue")).statusCode).toBe(200);
  });
});

describe("roles", () => {
  it("lets reception book but not give discounts or manage users", async () => {
    const { client: rx } = await userWithRole(app, admin, "RECEPTION", "desk2");
    expect((await rx.get("/api/users")).statusCode).toBe(403);
    const patient = (await rx.post("/api/patients", { name: "Kavya", sex: "F", phone: "9000000123", ageYears: 30 })).json();
    const doctor = (await rx.get("/api/practitioners")).json()[0];
    const slot = (await rx.get(`/api/practitioners/${doctor.id}/slots?date=2026-11-20`)).json().find((s: { available: boolean }) => s.available);
    const base = { patientId: patient.id, practitionerId: doctor.id, slotStart: slot.start, paymentMode: "CASH" };
    const withDiscount = await rx.post("/api/front-desk/checkout", { ...base, discount: 5_000, idempotencyKey: randomUUID() });
    expect(withDiscount.json().code).toBe("discount_not_allowed");
    expect((await rx.post("/api/front-desk/checkout", { ...base, idempotencyKey: randomUUID() })).statusCode).toBe(201);
  });

  it("lets a doctor see the queue but not register patients or bill", async () => {
    const { client: dr } = await userWithRole(app, admin, "DOCTOR", "drrao");
    expect((await dr.get("/api/queue")).statusCode).toBe(200);
    expect((await dr.post("/api/patients", { name: "X Y", sex: "M", phone: "9000000999", ageYears: 3 })).statusCode).toBe(403);
    expect((await dr.post("/api/front-desk/checkout", {})).statusCode).toBe(403);
  });

  it("records the real user in the audit trail", async () => {
    const { rows } = await db.query<{ actor: string }>("select actor from core.audit_event where action = 'frontdesk.checkout' order by seq desc limit 1");
    expect(rows[0]!.actor).toBe("desk2");
  });
});

describe("user administration", () => {
  it("deactivating a user signs them out everywhere", async () => {
    const { client: c, id } = await userWithRole(app, admin, "NURSE", "nurse1");
    expect((await c.get("/api/queue")).statusCode).toBe(200);
    expect((await admin.patch(`/api/users/${id}`, { active: false })).json().active).toBe(false);
    expect((await c.get("/api/queue")).statusCode).toBe(401);
    expect((await anon().post("/api/auth/login", { username: "nurse1", password: "real-pass-123" })).statusCode).toBe(401);
  });

  it("protects the last administrator and the admin's own account", async () => {
    const me = (await admin.get("/api/auth/status")).json().user;
    expect((await admin.patch(`/api/users/${me.id}`, { active: false })).json().code).toBe("cannot_change_self");
    const { id: other } = await userWithRole(app, admin, "ADMIN", "admin2");
    const { client: a2 } = { client: new Client(app) };
    await a2.post("/api/auth/login", { username: "admin2", password: "real-pass-123" });
    expect((await a2.patch(`/api/users/${me.id}`, { role: "RECEPTION" })).statusCode).toBe(200);
    expect((await a2.patch(`/api/users/${other}`, { active: false })).json().code).toBe("cannot_change_self");
  });

  it("rejects duplicate usernames with a field error", async () => {
    const res = await new Client(app).post("/api/auth/login", { username: "admin2", password: "real-pass-123" });
    expect(res.statusCode).toBe(200);
    const a2 = new Client(app, res.cookies.find((c) => c.name === "ojas_session")!.value);
    const dup = await a2.post("/api/users", { displayName: "Dup", username: "ravi", role: "LAB", password: "temp-pass-1" });
    expect(dup.json().details.fields).toHaveProperty("username");
  });
});
