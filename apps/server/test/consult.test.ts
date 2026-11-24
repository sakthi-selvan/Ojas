import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ConsultView, DaySlots, Encounter, PastVisit, Patient, Practitioner, QueueItem, Receipt, Suggestion } from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { makeApp, setupAdmin, userWithRole, type Client } from "./helpers.js";

const NOW = new Date(2026, 10, 20, 9, 0);
let db: Db;
let server: FastifyInstance;
let admin: Client, doctor: Client, nurse: Client, reception: Client;
let practitioner: Practitioner;
let patient: Patient;

beforeAll(async () => {
  ({ db, app: server } = await makeApp(() => NOW));
  admin = await setupAdmin(server);
  doctor = (await userWithRole(server, admin, "DOCTOR", "drananya")).client;
  nurse = (await userWithRole(server, admin, "NURSE", "nurse1")).client;
  reception = (await userWithRole(server, admin, "RECEPTION", "desk1")).client;
  practitioner = ((await admin.get("/api/practitioners")).json() as Practitioner[]).find((p) => p.name.includes("Ananya"))!;
  patient = (await admin.post("/api/patients", { name: "Meena Raj", sex: "F", phone: "9876501234", ageYears: 35 })).json();
});
afterAll(async () => {
  await server.close();
  await db.close();
});

let slotIndex = 0;
/** Books the next free slot today for the patient and returns the appointment id. */
async function book(p: Patient = patient): Promise<string> {
  const slots = ((await admin.get(`/api/practitioners/${practitioner.id}/slots?date=2026-11-20`)).json() as DaySlots).slots.filter((s) => s.available);
  const res = await admin.post("/api/front-desk/checkout", {
    patientId: p.id, practitionerId: practitioner.id, slotStart: slots[slotIndex++ % 3]!.start, paymentMode: "CASH", idempotencyKey: randomUUID(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as Receipt).appointmentId;
}

const notes = (over: object = {}) => ({
  notesVersion: 0,
  chiefComplaint: "Fever for 3 days",
  examination: "Throat congested",
  diagnoses: [{ text: "Acute pharyngitis", code: "j02.9" }],
  medications: [
    { drug: "Paracetamol", dose: "650 mg", frequency: "1-0-1", timing: "AFTER_FOOD", durationDays: 3 },
    { drug: "Cetirizine", dose: "10 mg", frequency: "0-0-1", timing: "BEDTIME", durationDays: 5 },
  ],
  labOrders: [{ test: "Complete blood count (CBC)" }],
  advice: "Warm saline gargles",
  followUpDate: "2026-11-27",
  ...over,
});

const queueItem = async (appointmentId: string) =>
  ((await admin.get("/api/queue?date=2026-11-20")).json() as QueueItem[]).find((i) => i.appointmentId === appointmentId)!;

describe("OPD consultation", () => {
  let first: string;

  it("nurse records vitals; the queue shows they are done; bad values are refused", async () => {
    first = await book();
    const bad = await nurse.put(`/api/consult/${first}/vitals`, { bpSystolic: 80, bpDiastolic: 90 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.fields).toHaveProperty("bpDiastolic");

    const res = await nurse.put(`/api/consult/${first}/vitals`, { weightKg: 62.5, heightCm: 160, temperatureF: 100.4, pulse: 96, bpSystolic: 118, bpDiastolic: 76, spo2: 98 });
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json() as Encounter;
    expect(e.status).toBe("DRAFT");
    expect(e.vitals.temperatureF).toBe(100.4);
    expect(e.vitals.respRate).toBeNull();
    expect(e.vitalsRecordedBy).toBe("nurse1");
    expect((await queueItem(first)).vitalsRecorded).toBe(true);
    // Recording vitals doesn't call the patient in.
    expect((await queueItem(first)).status).toBe("BOOKED");
  });

  it("keeps each role to its part", async () => {
    expect((await reception.get(`/api/consult/${first}`)).statusCode).toBe(403);
    expect((await reception.put(`/api/consult/${first}/vitals`, { pulse: 80 })).statusCode).toBe(403);
    expect((await nurse.get(`/api/consult/${first}`)).statusCode).toBe(200);
    expect((await nurse.put(`/api/consult/${first}/notes`, notes())).statusCode).toBe(403);
    expect((await nurse.post(`/api/consult/${first}/sign`)).statusCode).toBe(403);
    expect((await doctor.get("/api/consult/not-a-uuid")).statusCode).toBe(404);
  });

  it("doctor's draft calls the patient in, and a stale save is refused instead of overwriting", async () => {
    const res = await doctor.put(`/api/consult/${first}/notes`, notes());
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json() as Encounter;
    expect(e.notesVersion).toBe(1);
    expect(e.diagnoses[0]).toEqual({ text: "Acute pharyngitis", code: "J02.9" });
    expect(e.medications.map((m) => m.drug)).toEqual(["Paracetamol", "Cetirizine"]);
    expect(e.vitals.pulse).toBe(96); // the nurse's vitals are untouched
    expect((await queueItem(first)).status).toBe("IN_CONSULT");

    const stale = await doctor.put(`/api/consult/${first}/notes`, notes({ chiefComplaint: "older copy" }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("changed_elsewhere");
  });

  it("signing locks the record and completes the visit", async () => {
    const res = await doctor.post(`/api/consult/${first}/sign`);
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json() as Encounter;
    expect(e.status).toBe("SIGNED");
    expect(e.version).toBe(1);
    expect(e.signedBy).toBe("drananya");
    expect((await queueItem(first)).status).toBe("DONE");

    expect((await doctor.put(`/api/consult/${first}/notes`, notes({ notesVersion: 1 }))).json().code).toBe("encounter_signed");
    expect((await nurse.put(`/api/consult/${first}/vitals`, { pulse: 70 })).json().code).toBe("encounter_signed");
    expect((await doctor.post(`/api/consult/${first}/sign`)).statusCode).toBe(409);

    const view = (await doctor.get(`/api/consult/${first}`)).json() as ConsultView;
    expect(view.patient.name).toBe("Meena Raj");
    expect(view.practitioner.name).toContain("Ananya");
    expect(view.facility.name).toBe("Ojas Demo Clinic");
  });

  it("a correction needs a reason and adds a version; the signed one is kept", async () => {
    expect((await doctor.post(`/api/consult/${first}/reopen`, { reason: "" })).statusCode).toBe(400);
    const reopened = (await doctor.post(`/api/consult/${first}/reopen`, { reason: "Wrong dose of paracetamol" })).json() as Encounter;
    expect(reopened.status).toBe("DRAFT");
    expect(reopened.reopenReason).toBe("Wrong dose of paracetamol");

    const fixed = notes({ notesVersion: reopened.notesVersion });
    fixed.medications[0]!.dose = "500 mg";
    expect((await doctor.put(`/api/consult/${first}/notes`, fixed)).statusCode).toBe(200);
    const signed = (await doctor.post(`/api/consult/${first}/sign`)).json() as Encounter;
    expect(signed.version).toBe(2);
    expect(signed.reopenReason).toBeNull();

    const versions = (await doctor.get(`/api/consult/${first}/versions`)).json() as { version: number; reason: string | null; content: Encounter }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]!.content.medications[0]!.dose).toBe("650 mg");
    expect(versions[1]!.content.medications[0]!.dose).toBe("500 mg");
    expect(versions[1]!.reason).toBe("Wrong dose of paracetamol");

    expect((await admin.get("/api/audit/verify")).json().ok).toBe(true);
  });

  it("shows the patient's earlier visits on the next one", async () => {
    const next = await book();
    const history = (await doctor.get(`/api/consult/${next}/history`)).json() as PastVisit[];
    expect(history).toHaveLength(1);
    expect(history[0]!.appointmentId).toBe(first);
    expect(history[0]!.medications[0]).toMatchObject({ drug: "Paracetamol", dose: "500 mg", durationDays: 3 });
    expect(history[0]!.vitals.weightKg).toBe(62.5);
    // The visit being written doesn't list itself.
    expect((await doctor.get(`/api/consult/${first}/history`)).json()).toHaveLength(0);
  });

  it("won't sign an empty consultation or one for a cancelled appointment", async () => {
    const other = await book((await admin.post("/api/patients", { name: "Arun Das", sex: "M", phone: "9876505678", ageYears: 50 })).json());
    expect((await doctor.post(`/api/consult/${other}/sign`)).json().code).toBe("nothing_to_sign");
    await doctor.put(`/api/consult/${other}/notes`, { notesVersion: 0 });
    expect((await doctor.post(`/api/consult/${other}/sign`)).json().code).toBe("nothing_to_sign");

    const cancelled = await book();
    expect((await admin.patch(`/api/appointments/${cancelled}/status`, { status: "CANCELLED" })).statusCode).toBe(200);
    expect((await doctor.put(`/api/consult/${cancelled}/notes`, notes())).json().code).toBe("appointment_cancelled");
  });

  it("suggests what the clinic has written before", async () => {
    const drugs = (await doctor.get("/api/consult/suggestions?kind=drug&q=para")).json() as Suggestion[];
    expect(drugs[0]).toMatchObject({ text: "Paracetamol", med: { dose: "500 mg", frequency: "1-0-1", durationDays: 3 } });
    const dx = (await doctor.get("/api/consult/suggestions?kind=diagnosis&q=phar")).json() as Suggestion[];
    expect(dx[0]).toMatchObject({ text: "Acute pharyngitis", code: "J02.9" });
    const labs = (await doctor.get("/api/consult/suggestions?kind=lab&q=lip")).json() as Suggestion[];
    expect(labs.map((l) => l.text)).toContain("Lipid profile");
    const cbc = (await doctor.get("/api/consult/suggestions?kind=lab&q=cbc")).json() as Suggestion[];
    expect(cbc[0]).toMatchObject({ text: "Complete blood count (CBC)", uses: 1 });
    expect((await doctor.get("/api/consult/suggestions?kind=drug&q=%25_")).statusCode).toBe(200);
    expect((await doctor.get("/api/consult/suggestions?kind=nope&q=x")).statusCode).toBe(400);
  });
});
