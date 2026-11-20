import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Practitioner, Patient, Receipt, Slot } from "@ojas/shared";
import { openDb, type Db } from "../src/db/index.js";
import { seedIfEmpty } from "../src/db/seed.js";
import { buildApp } from "../src/app.js";
import { financialYear } from "../src/core/numbering.js";

// Fixed "now": 2026-11-20 10:02 local time, so slots are deterministic.
const NOW = new Date(2026, 10, 20, 10, 2);
let db: Db;
let app: FastifyInstance;
let doctor: Practitioner;

beforeAll(async () => {
  db = await openDb({}); // in-memory PGlite
  await seedIfEmpty(db);
  app = await buildApp({ db, now: () => NOW });
  const res = await app.inject({ url: "/api/practitioners" });
  doctor = (res.json() as Practitioner[]).find((p) => p.name.includes("Ananya"))!;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const register = (body: object, force = false) =>
  app.inject({ method: "POST", url: `/api/patients${force ? "?force=true" : ""}`, payload: body });

const firstFreeSlot = async (): Promise<Slot> => {
  const res = await app.inject({ url: `/api/practitioners/${doctor.id}/slots?date=2026-11-20` });
  return (res.json() as Slot[]).find((s) => s.available)!;
};

describe("quick registration", () => {
  it("registers with 4 fields, normalises name and phone, assigns UHID", async () => {
    const res = await register({ name: "  ravi   KUMAR ", sex: "M", phone: "+91 98400 12345", ageYears: 42 });
    expect(res.statusCode).toBe(201);
    const p = res.json() as Patient;
    expect(p.name).toBe("Ravi Kumar");
    expect(p.phone).toBe("9840012345");
    expect(p.uhid).toBe("OJ-000001");
    expect(p.dobEstimated).toBe(true);
  });

  it("rejects invalid input with a field-level message", async () => {
    const res = await register({ name: "A", sex: "M", phone: "12345" });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.fields).toHaveProperty("phone");
  });

  it("flags a likely duplicate and allows override", async () => {
    const dup = await register({ name: "Ravi Kumar", sex: "M", phone: "9840012345", ageYears: 42 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().details.existing.uhid).toBe("OJ-000001");
    const forced = await register({ name: "Ravi Kumar", sex: "M", phone: "9840012345", ageYears: 12 }, true);
    expect(forced.statusCode).toBe(201);
    expect((forced.json() as Patient).uhid).toBe("OJ-000002");
  });

  it("finds patients by phone prefix, last digits, UHID and name", async () => {
    for (const q of ["98400", "2345", "OJ-000001", "ravi", "kum"]) {
      const res = await app.inject({ url: `/api/patients/search?q=${encodeURIComponent(q)}` });
      expect((res.json() as Patient[]).length, q).toBeGreaterThan(0);
    }
  });
});

describe("front-desk checkout", () => {
  let patient: Patient;
  beforeAll(async () => {
    patient = (await register({ name: "Lakshmi Devi", sex: "F", phone: "9000000001", ageYears: 60 })).json();
  });

  it("hides slots that have already ended but keeps the current one", async () => {
    const slot = await firstFreeSlot();
    expect(new Date(slot.start)).toEqual(new Date(2026, 10, 20, 10, 0));
  });

  it("books, bills and takes payment in one call", async () => {
    const slot = await firstFreeSlot();
    const res = await app.inject({
      method: "POST", url: "/api/front-desk/checkout",
      payload: { patientId: patient.id, practitionerId: doctor.id, slotStart: slot.start, discount: 5_000, paymentMode: "UPI", idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(201);
    const r = res.json() as Receipt;
    expect(r.token).toBe(1);
    expect(r.subtotal).toBe(50_000);
    expect(r.total).toBe(45_000);
    expect(r.invoiceNo).toBe(`INV/${financialYear(NOW)}/000001`);

    const reprint = await app.inject({ url: `/api/invoices/${r.invoiceId}/receipt` });
    expect(reprint.json()).toMatchObject({ invoiceNo: r.invoiceNo, total: 45_000, paymentMode: "UPI", token: 1 });

    const queue = await app.inject({ url: "/api/queue?date=2026-11-20" });
    expect(queue.json()).toHaveLength(1);
  });

  it("is idempotent: a retried request does not double-book or double-bill", async () => {
    const slot = await firstFreeSlot();
    const payload = { patientId: patient.id, practitionerId: doctor.id, slotStart: slot.start, paymentMode: "CASH", idempotencyKey: randomUUID() };
    const a = (await app.inject({ method: "POST", url: "/api/front-desk/checkout", payload })).json() as Receipt;
    const b = (await app.inject({ method: "POST", url: "/api/front-desk/checkout", payload })).json() as Receipt;
    expect(b.invoiceNo).toBe(a.invoiceNo);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from core.invoice");
    expect(rows[0]!.n).toBe(2);
  });

  it("refuses a slot that is already taken, without burning invoice numbers", async () => {
    const taken = (await app.inject({ url: "/api/queue?date=2026-11-20" })).json()[0].slotStart;
    const res = await app.inject({
      method: "POST", url: "/api/front-desk/checkout",
      payload: { patientId: patient.id, practitionerId: doctor.id, slotStart: taken, paymentMode: "CASH", idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("slot_taken");
    const next = (await app.inject({
      method: "POST", url: "/api/front-desk/checkout",
      payload: { patientId: patient.id, practitionerId: doctor.id, slotStart: (await firstFreeSlot()).start, paymentMode: "CASH", idempotencyKey: randomUUID() },
    })).json() as Receipt;
    expect(next.invoiceNo).toBe(`INV/${financialYear(NOW)}/000003`);
    expect(next.token).toBe(3);
  });

  it("rejects off-grid and past slots, and over-discount", async () => {
    const base = { patientId: patient.id, practitionerId: doctor.id, paymentMode: "CASH" };
    const offGrid = await app.inject({ method: "POST", url: "/api/front-desk/checkout", payload: { ...base, slotStart: new Date(2026, 10, 20, 11, 3).toISOString(), idempotencyKey: randomUUID() } });
    expect(offGrid.json().code).toBe("invalid_slot");
    const past = await app.inject({ method: "POST", url: "/api/front-desk/checkout", payload: { ...base, slotStart: new Date(2026, 10, 20, 9, 0).toISOString(), idempotencyKey: randomUUID() } });
    expect(past.json().code).toBe("slot_in_past");
    const disc = await app.inject({ method: "POST", url: "/api/front-desk/checkout", payload: { ...base, slotStart: (await firstFreeSlot()).start, discount: 999_999, idempotencyKey: randomUUID() } });
    expect(disc.json().code).toBe("discount_too_large");
  });
});

describe("queue & audit", () => {
  it("moves visits forward only", async () => {
    const [first] = (await app.inject({ url: "/api/queue?date=2026-11-20" })).json();
    const ok = await app.inject({ method: "PATCH", url: `/api/appointments/${first.appointmentId}/status`, payload: { status: "IN_CONSULT" } });
    expect(ok.statusCode).toBe(200);
    const back = await app.inject({ method: "PATCH", url: `/api/appointments/${first.appointmentId}/status`, payload: { status: "BOOKED" } });
    expect(back.statusCode).toBe(422);
  });

  it("keeps an intact audit hash chain, and detects tampering", async () => {
    expect((await app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true });
    await db.query("update core.audit_event set actor = 'mallory' where seq = 2");
    expect((await app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: false, brokenAt: 2 });
  });
});
