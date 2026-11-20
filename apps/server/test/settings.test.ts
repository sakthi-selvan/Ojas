import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DaySlots, Facility, Practitioner } from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { makeApp, setupAdmin, userWithRole, type Client } from "./helpers.js";

// Friday 2026-11-20, 09:00 local.
const NOW = new Date(2026, 10, 20, 9, 0);
let db: Db;
let app: FastifyInstance;
let admin: Client;
let anon: () => Client;

const weekdays = (start: string, end: string, days = [1, 2, 3, 4, 5]) => days.map((weekday) => ({ weekday, start, end }));
const doctorBody = {
  name: "Dr. Kavya Nair", department: "General Medicine", qualification: "MBBS, MD", registrationNo: "TNMC 12345", phone: "9840011111",
  consultationFee: 40_000, slotMinutes: 15,
  sessions: [...weekdays("09:00", "12:00"), ...weekdays("17:00", "19:00"), { weekday: 6, start: "09:00", end: "11:00" }],
};
const put = (url: string, payload: object) => admin.req({ method: "PUT", url, payload });
const del = (url: string) => admin.req({ method: "DELETE", url });

beforeAll(async () => {
  ({ db, app, anon } = await makeApp(() => NOW, { demo: false })); // a fresh install: no demo data
  admin = await setupAdmin(app);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("first-run setup", () => {
  let doctor: Practitioner;

  it("starts blank and reports setup as incomplete (publicly, for the sign-in screen)", async () => {
    expect((await anon().get("/api/facility")).json()).toMatchObject({ name: "", setupCompleted: false });
    expect((await admin.get("/api/practitioners")).json()).toEqual([]);
  });

  it("can't finish without a doctor", async () => {
    const res = await admin.post("/api/settings/complete-setup");
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("no_doctors");
  });

  it("saves clinic details and validates them", async () => {
    const bad = await put("/api/settings/facility", { name: "X", gstin: "123" });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(bad.json().details.fields)).toEqual(expect.arrayContaining(["name", "gstin"]));
    const ok = await put("/api/settings/facility", {
      name: "Sunrise Clinic", address: "4 Anna Salai, Chennai", phone: "044-2222 3333", email: "", gstin: "33AABCU9603R1ZM", receiptFooter: "Thank you", uhidPrefix: "SR-",
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Facility).uhidPrefix).toBe("SR-");
  });

  it("adds a doctor with morning and evening sessions", async () => {
    const res = await admin.post("/api/settings/practitioners", doctorBody);
    expect(res.statusCode).toBe(201);
    doctor = res.json();
    expect(doctor.sessions).toHaveLength(11);
    expect(doctor.registrationNo).toBe("TNMC 12345");
  });

  it("rejects overlapping or too-short sessions with a clear message", async () => {
    const overlap = await admin.post("/api/settings/practitioners", {
      ...doctorBody, sessions: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "11:00", end: "13:00" }],
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().message).toMatch(/overlap/i);
    const short = await admin.post("/api/settings/practitioners", { ...doctorBody, sessions: [{ weekday: 1, start: "09:00", end: "09:10" }] });
    expect(short.statusCode).toBe(400);
  });

  it("finishes setup", async () => {
    expect((await admin.post("/api/settings/complete-setup")).statusCode).toBe(200);
    expect((await anon().get("/api/facility")).json().setupCompleted).toBe(true);
  });

  it("builds slots from the sessions of that weekday only", async () => {
    const fri = (await admin.get(`/api/practitioners/${doctor.id}/slots?date=2026-11-20`)).json() as DaySlots;
    expect(fri.closed).toBeUndefined();
    expect(fri.slots).toHaveLength(12 + 8); // 09–12 and 17–19 in 15-minute slots
    const sun = (await admin.get(`/api/practitioners/${doctor.id}/slots?date=2026-11-22`)).json() as DaySlots;
    expect(sun.slots).toEqual([]);
    expect(sun.closed).toMatch(/doesn't consult on Sundays/);
  });

  it("uses the clinic's patient ID prefix, then locks it", async () => {
    const p = await admin.post("/api/patients", { name: "Lakshmi Devi", sex: "F", phone: "9840022222", ageYears: 60 });
    expect(p.json().uhid).toBe("SR-000001");
    const f = (await admin.get("/api/settings/facility")).json() as Facility;
    expect(f.hasPatients).toBe(true);
    const change = await put("/api/settings/facility", { ...f, uhidPrefix: "XY-" });
    expect(change.statusCode).toBe(422);
    expect(change.json().details.fields).toHaveProperty("uhidPrefix");
  });

  it("is admin-only, but reception still sees the doctors to book", async () => {
    const { client: rx } = await userWithRole(app, admin, "RECEPTION", "rita");
    expect((await rx.get("/api/settings/facility")).statusCode).toBe(403);
    expect((await rx.post("/api/settings/practitioners", doctorBody)).statusCode).toBe(403);
    expect((await rx.get("/api/practitioners")).json()).toHaveLength(1);
  });

  describe("holidays and leave", () => {
    const newPatient = async () =>
      (await admin.post("/api/patients?force=true", { name: "Mohan Raj", sex: "M", phone: "9840033333", ageYears: 30 })).json();
    const checkoutAt = async (slotStart: string) =>
      admin.post("/api/front-desk/checkout", { patientId: (await newPatient()).id, practitionerId: doctor.id, slotStart, paymentMode: "CASH", idempotencyKey: randomUUID() });
    const slotsOn = async (date: string) => (await admin.get(`/api/practitioners/${doctor.id}/slots?date=${date}`)).json() as DaySlots;

    it("a holiday closes the day, reports existing bookings, and blocks new ones", async () => {
      const slot = (await slotsOn("2026-11-23")).slots.find((s) => s.available)!;
      expect((await checkoutAt(slot.start)).statusCode).toBe(201);
      const res = await admin.post("/api/settings/holidays", { date: "2026-11-23", name: "Local festival" });
      expect(res.statusCode).toBe(201);
      expect(res.json().bookedPatients).toBe(1);
      expect((await slotsOn("2026-11-23")).closed).toBe("Clinic closed: Local festival");
      const blocked = await checkoutAt(new Date(new Date(slot.start).getTime() + 15 * 60_000).toISOString());
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json().code).toBe("day_closed");
      expect((await admin.post("/api/settings/holidays", { date: "2026-11-23", name: "Again" })).statusCode).toBe(409);
      expect((await admin.get("/api/settings/holidays")).json()).toEqual([{ date: "2026-11-23", name: "Local festival" }]);
    });

    it("removing the holiday reopens the day", async () => {
      expect((await del("/api/settings/holidays/2026-11-23")).statusCode).toBe(200);
      const day = await slotsOn("2026-11-23");
      expect(day.closed).toBeUndefined();
      expect(day.slots.length).toBeGreaterThan(0);
    });

    it("doctor leave closes only that doctor's days and says when they're back", async () => {
      const res = await admin.post("/api/settings/leaves", { practitionerId: doctor.id, fromDate: "2026-11-24", toDate: "2026-11-25", reason: "Conference" });
      expect(res.statusCode).toBe(201);
      expect((await slotsOn("2026-11-25")).closed).toMatch(/Dr\. Kavya Nair is on leave \(Conference\), back Thu,? 26 Nov/);
      expect((await admin.post("/api/settings/leaves", { practitionerId: doctor.id, fromDate: "2026-11-25", toDate: "2026-11-27" })).statusCode).toBe(409);
      expect((await admin.post("/api/settings/leaves", { practitionerId: doctor.id, fromDate: "2026-11-27", toDate: "2026-11-24" })).statusCode).toBe(400);
      expect((await admin.get("/api/settings/leaves")).json()).toHaveLength(1);
      expect((await del(`/api/settings/leaves/${res.json().leave.id}`)).statusCode).toBe(200);
      expect((await admin.get("/api/settings/leaves")).json()).toEqual([]);
    });

    it("deactivating a doctor hides them from the front desk but keeps them in settings", async () => {
      expect((await put(`/api/settings/practitioners/${doctor.id}`, { ...doctorBody, active: false })).statusCode).toBe(200);
      expect((await admin.get("/api/practitioners")).json()).toEqual([]);
      expect((await admin.get("/api/settings/practitioners")).json()).toHaveLength(1);
    });

    it("every settings change is in the audit trail, and the chain still verifies", async () => {
      const { rows } = await db.query<{ action: string }>("select action from core.audit_event where action like 'settings.%'");
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining([
        "settings.facility", "settings.practitioner.create", "settings.setup_completed", "settings.holiday.add",
        "settings.holiday.delete", "settings.leave.add", "settings.leave.delete", "settings.practitioner.update",
      ]));
      expect((await admin.get("/api/audit/verify")).json().ok).toBe(true);
    });
  });
});
