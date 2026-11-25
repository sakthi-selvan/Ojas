import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { expandBeds, midnightsBetween, type Admission, type AdmissionSummary, type IpdService, type Patient, type Practitioner, type Ward } from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { ADMIN, makeApp, setupAdmin, userWithRole, type Client } from "./helpers.js";

let clock = new Date(2026, 10, 20, 10, 0);
/** Moves the clock, then signs everyone in again (a jump of hours ends idle sessions, as at a real desk). */
const at = async (d: number, h: number, m = 0) => {
  clock = new Date(2026, 10, d, h, m);
  await admin.post("/api/auth/login", { username: ADMIN.username, password: ADMIN.password });
  for (const [c, username] of [[desk, "desk1"], [doctor, "drkavya"], [nurse, "nurse1"], [accounts, "acc1"]] as const) {
    await c.post("/api/auth/login", { username, password: "real-pass-123" });
  }
};
let db: Db;
let server: FastifyInstance;
let admin: Client, desk: Client, doctor: Client, nurse: Client, accounts: Client;
let meena: Patient, ravi: Patient, doc: Practitioner;
let general: Ward, icu: Ward, visit: IpdService;
let adm: Admission;

const bed = (w: Ward, label: string) => w.beds.find((b) => b.label === label)!;
const admit = (patient: Patient, bedId: string, extra: object = {}, as: Client = desk) =>
  as.post("/api/ipd/admissions", { patientId: patient.id, practitionerId: doc.id, bedId, reason: "Dengue fever with low platelets", idempotencyKey: randomUUID(), ...extra });
const board = async () => (await nurse.get("/api/ipd/wards")).json() as Ward[];
const ok = <T>(res: { statusCode: number; body: string; json: () => unknown }, code = 200): T => {
  expect(res.statusCode, res.body).toBe(code);
  return res.json() as T;
};

beforeAll(async () => {
  ({ db, app: server } = await makeApp(() => clock));
  admin = await setupAdmin(server);
  desk = (await userWithRole(server, admin, "RECEPTION", "desk1")).client;
  doctor = (await userWithRole(server, admin, "DOCTOR", "drkavya")).client;
  nurse = (await userWithRole(server, admin, "NURSE", "nurse1")).client;
  accounts = (await userWithRole(server, admin, "ACCOUNTS", "acc1")).client;
  meena = (await admin.post("/api/patients", { name: "Meena Raj", sex: "F", phone: "9876501234", ageYears: 35 })).json();
  ravi = (await admin.post("/api/patients", { name: "Ravi Kumar", sex: "M", phone: "9876505678", ageYears: 52 })).json();
  doc = (await admin.get("/api/practitioners")).json()[0];
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe("bed-day rules", () => {
  it("counts the midnights crossed", () => {
    expect(midnightsBetween(new Date(2026, 10, 20, 22), new Date(2026, 10, 22, 10))).toHaveLength(2);
    expect(midnightsBetween(new Date(2026, 10, 20, 8), new Date(2026, 10, 20, 20))).toHaveLength(0);
    expect(midnightsBetween(new Date(2026, 10, 20, 8), new Date(2026, 10, 21, 0))).toHaveLength(1);
  });
  it("expands bed ranges", () => {
    expect(expandBeds("G1-G3, 10")).toEqual(["G1", "G2", "G3", "10"]);
    expect(expandBeds("101-103")).toEqual(["101", "102", "103"]);
    expect(expandBeds("B-08 - 10")).toEqual(["B-08", "B-09", "B-10"]);
  });
});

describe("wards and services", () => {
  it("admin sets up wards with daily rates; names are unique; others can't", async () => {
    general = ok(await admin.post("/api/ipd/wards", { name: "General ward", kind: "GENERAL", bedCharge: 100_000, nursingCharge: 20_000, beds: ["G1", "G2", "G3"] }), 201);
    icu = ok(await admin.post("/api/ipd/wards", { name: "ICU", kind: "ICU", bedCharge: 500_000, nursingCharge: 100_000, beds: ["ICU-1", "ICU-2"] }), 201);
    expect(general.beds.map((b) => [b.label, b.state])).toEqual([["G1", "FREE"], ["G2", "FREE"], ["G3", "FREE"]]);
    expect((await admin.post("/api/ipd/wards", { name: "ICU", kind: "ICU", bedCharge: 1, beds: ["X"] })).json().code).toBe("ward_exists");
    expect((await admin.post("/api/ipd/wards", { name: "Dup", kind: "OTHER", bedCharge: 1, beds: ["a", "A"] })).statusCode).toBe(400);
    expect((await desk.post("/api/ipd/wards", { name: "W", kind: "OTHER", bedCharge: 1, beds: ["1"] })).statusCode).toBe(403);
    visit = ok(await admin.post("/api/ipd/services", { name: "Doctor visit", category: "DOCTOR", price: 50_000 }), 201);
    expect(ok<IpdService[]>(await desk.get("/api/ipd/services")).map((s) => s.name)).toEqual(["Doctor visit"]);
  });
});

describe("admission to discharge", () => {
  it("admits with an advance (idempotently); a bed or a patient can't be taken twice", async () => {
    const key = randomUUID();
    adm = ok(await admit(meena, bed(general, "G1").id, { deposit: 500_000, paymentMode: "UPI", attendantName: "Raj", attendantRelation: "Husband", attendantPhone: "+91 98765 00000", idempotencyKey: key }), 201);
    expect(adm).toMatchObject({ admissionNo: "IP/26-27/000001", status: "ADMITTED", attendant: { phone: "9876500000" }, bed: { label: "G1", wardName: "General ward" } });
    expect(adm.payments).toMatchObject([{ receiptNo: "IPR/26-27/000001", kind: "DEPOSIT", amount: 500_000, mode: "UPI" }]);
    expect(adm.bill).toMatchObject({ days: 1, subtotal: 120_000, paid: 500_000, balance: -380_000 });
    expect(ok<Admission>(await admit(meena, bed(general, "G1").id, { deposit: 500_000, idempotencyKey: key }), 201).id).toBe(adm.id);
    expect((await admit(meena, bed(general, "G2").id)).json().code).toBe("already_admitted");
    expect((await admit(ravi, bed(general, "G1").id)).json().code).toBe("bed_taken");
    expect((await admit(ravi, bed(general, "G2").id, {}, nurse)).statusCode).toBe(403);
    const g1 = bed((await board()).find((w) => w.id === general.id)!, "G1");
    expect(g1).toMatchObject({ state: "OCCUPIED", occupant: { patientName: "Meena Raj", admissionNo: "IP/26-27/000001", dischargeAdvised: false } });
    expect(ok<AdmissionSummary[]>(await nurse.get("/api/ipd/admissions")).map((a) => a.patient.name)).toEqual(["Meena Raj"]);
  });

  it("charts vitals, notes and medicines; each role writes only its own part", async () => {
    await at(20, 14);
    expect((await nurse.post(`/api/ipd/admissions/${adm.id}/vitals`, {})).json().code).toBe("vitals_empty");
    ok(await nurse.post(`/api/ipd/admissions/${adm.id}/vitals`, { temperatureF: 101.2, pulse: 104, bpSystolic: 100, bpDiastolic: 64 }));
    ok(await nurse.post(`/api/ipd/admissions/${adm.id}/notes`, { kind: "NURSING", text: "Oral fluids encouraged. Intake 1.2 L." }));
    expect((await nurse.post(`/api/ipd/admissions/${adm.id}/notes`, { kind: "DOCTOR", text: "Plan" })).statusCode).toBe(403);
    expect((await nurse.post(`/api/ipd/admissions/${adm.id}/meds`, { drug: "Paracetamol" })).statusCode).toBe(403);
    ok(await doctor.post(`/api/ipd/admissions/${adm.id}/notes`, { kind: "DOCTOR", text: "Platelets 62k. Watch for bleeding." }));
    adm = ok(await doctor.post(`/api/ipd/admissions/${adm.id}/meds`, { drug: "Paracetamol", dose: "650 mg", frequency: "SOS", route: "ORAL" }));
    const med = adm.meds[0]!;
    expect(med.med).toMatchObject({ drug: "Paracetamol", route: "ORAL", durationDays: null });
    ok(await nurse.post(`/api/ipd/meds/${med.id}/doses`, {}));
    expect((await nurse.post(`/api/ipd/meds/${med.id}/doses`, { status: "HELD" })).statusCode).toBe(400);
    adm = ok(await nurse.post(`/api/ipd/meds/${med.id}/doses`, { status: "HELD", note: "Temp normal" }));
    expect(adm.meds[0]!.doses.map((d) => [d.status, d.note, d.by])).toEqual([["HELD", "Temp normal", "NURSE nurse1"], ["GIVEN", "", "NURSE nurse1"]]);
    expect(adm.meds[0]!.doses).toHaveLength(2);
    adm = ok(await doctor.post(`/api/ipd/meds/${med.id}/stop`, { reason: "Afebrile" }));
    expect(adm.meds[0]).toMatchObject({ stopReason: "Afebrile", stoppedBy: "DOCTOR drkavya" });
    expect((await nurse.post(`/api/ipd/meds/${med.id}/doses`, {})).json().code).toBe("med_stopped");
    expect(adm.notes.map((n) => n.kind)).toEqual(["DOCTOR", "NURSING"]);
    expect(adm.vitals[0]!.vitals).toMatchObject({ pulse: 104, spo2: null });
  });

  it("adds and cancels charges, and takes more advance", async () => {
    ok(await desk.post(`/api/ipd/admissions/${adm.id}/charges`, { serviceId: visit.id, description: "Doctor visit", category: "DOCTOR", quantity: 2, unitPrice: 50_000 }));
    adm = ok(await accounts.post(`/api/ipd/admissions/${adm.id}/charges`, { description: "Platelet count kit", category: "CONSUMABLE", quantity: 1, unitPrice: 30_000 }));
    expect((await nurse.post(`/api/ipd/admissions/${adm.id}/charges`, { description: "X", category: "OTHER", quantity: 1, unitPrice: 1 })).statusCode).toBe(403);
    const kit = adm.charges.find((c) => c.category === "CONSUMABLE")!;
    expect((await desk.post(`/api/ipd/charges/${kit.id}/cancel`, { reason: "" })).statusCode).toBe(400);
    adm = ok(await desk.post(`/api/ipd/charges/${kit.id}/cancel`, { reason: "Entered twice" }));
    expect(adm.charges.find((c) => c.id === kit.id)).toMatchObject({ cancelReason: "Entered twice" });
    expect(adm.bill.lines.map((l) => [l.description, l.quantity, l.amount])).toEqual([
      ["General ward · bed G1", 1, 100_000], ["Nursing · General ward", 1, 20_000], ["Doctor visit", 2, 100_000],
    ]);
    const key = randomUUID();
    adm = ok(await desk.post(`/api/ipd/admissions/${adm.id}/deposits`, { amount: 300_000, paymentMode: "CASH", idempotencyKey: key }));
    ok(await desk.post(`/api/ipd/admissions/${adm.id}/deposits`, { amount: 300_000, paymentMode: "CASH", idempotencyKey: key }));
    adm = ok(await nurse.get(`/api/ipd/admissions/${adm.id}`));
    expect(adm.payments.map((p) => p.receiptNo)).toEqual(["IPR/26-27/000001", "IPR/26-27/000002"]);
    expect(adm.bill.paid).toBe(800_000);
  });

  it("moves beds; the old bed waits for cleaning; each night is charged at the ward slept in", async () => {
    await at(21, 15);
    expect((await desk.post(`/api/ipd/admissions/${adm.id}/transfer`, { bedId: bed(general, "G1").id, reason: "x moves" })).json().code).toBe("same_bed");
    adm = ok(await desk.post(`/api/ipd/admissions/${adm.id}/transfer`, { bedId: bed(icu, "ICU-1").id, reason: "Platelets fell to 18k" }));
    expect(adm.bed).toMatchObject({ label: "ICU-1", wardName: "ICU" });
    expect(adm.stays.map((s) => [s.bedLabel, !!s.to])).toEqual([["G1", true], ["ICU-1", false]]);
    const g1 = bed((await board()).find((w) => w.id === general.id)!, "G1");
    expect(g1.state).toBe("CLEANING");
    expect((await admit(ravi, g1.id)).json().code).toBe("bed_cleaning");
    expect((await desk.post(`/api/ipd/beds/${g1.id}/ready`)).statusCode).toBe(204);
    expect((await desk.post(`/api/ipd/beds/${g1.id}/ready`)).json().code).toBe("bed_not_cleaning");
    expect((await accounts.post(`/api/ipd/beds/${g1.id}/ready`)).statusCode).toBe(403);
    // A ward with a patient in it can't lose that bed.
    expect((await admin.put(`/api/ipd/wards/${icu.id}`, { name: "ICU", kind: "ICU", bedCharge: 500_000, nursingCharge: 100_000, beds: ["ICU-2"] })).json().code).toBe("bed_occupied");
    // A rate change applies to new stays only.
    ok(await admin.put(`/api/ipd/wards/${icu.id}`, { name: "ICU", kind: "ICU", bedCharge: 600_000, nursingCharge: 100_000, beds: ["ICU-1", "ICU-2", "ICU-3"] }));
    await at(23, 11);
    adm = ok(await nurse.get(`/api/ipd/admissions/${adm.id}`));
    expect(adm.bill.days).toBe(3);
    expect(adm.bill.lines.filter((l) => l.category === "BED").map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ["General ward · bed G1", 1, 100_000], ["ICU · bed ICU-1", 2, 500_000],
    ]);
    // 1 × (1000 + 200) + 2 × (5000 + 1000) + 2 × 500 = 14,200
    expect(adm.bill.subtotal).toBe(1_420_000);
  });

  it("discharges only after the doctor signs the summary, collects the balance, and locks the record", async () => {
    const settle = (body: object = {}, as: Client = desk) =>
      as.post(`/api/ipd/admissions/${adm.id}/discharge`, { paymentMode: "CASH", expectedSubtotal: adm.bill.subtotal, idempotencyKey: randomUUID(), ...body });
    expect((await settle()).json().code).toBe("summary_not_signed");
    expect((await nurse.put(`/api/ipd/admissions/${adm.id}/summary`, { summaryVersion: 0 })).statusCode).toBe(403);
    adm = ok(await doctor.put(`/api/ipd/admissions/${adm.id}/summary`, { summaryVersion: 0, courseInHospital: "Treated conservatively." }));
    const incomplete = await doctor.post(`/api/ipd/admissions/${adm.id}/summary/sign`, { summaryVersion: 1 });
    expect(incomplete.json()).toMatchObject({ code: "summary_incomplete", details: { fields: { diagnoses: "Add the final diagnosis" } } });
    expect((await doctor.put(`/api/ipd/admissions/${adm.id}/summary`, { summaryVersion: 0 })).json().code).toBe("changed_elsewhere");
    adm = ok(await doctor.put(`/api/ipd/admissions/${adm.id}/summary`, {
      summaryVersion: 1, diagnoses: [{ text: "Dengue fever with thrombocytopenia", code: "a97.1" }], conditionAtDischarge: "Stable, platelets 1.2 lakh",
      medications: [{ drug: "ORS", dose: "1 sachet", frequency: "1-1-1", durationDays: 5 }], followUpDate: "2026-11-30",
    }));
    expect(adm.summary!.diagnoses[0]!.code).toBe("A97.1");
    adm = ok(await doctor.post(`/api/ipd/admissions/${adm.id}/summary/sign`, { summaryVersion: 2 }));
    expect(adm.summarySignedBy).toBe("DOCTOR drkavya");
    expect(bed((await board()).find((w) => w.id === icu.id)!, "ICU-1").occupant!.dischargeAdvised).toBe(true);

    expect((await settle({ expectedSubtotal: 1_000 })).json().code).toBe("bill_changed");
    expect((await settle({ discount: 20_000 })).json().code).toBe("discount_not_allowed");
    expect((await settle({ discount: 9_999_999 }, accounts)).json().code).toBe("discount_too_large");
    adm = ok(await settle({ discount: 20_000, paymentMode: "CARD" }, accounts));
    expect(adm).toMatchObject({ status: "DISCHARGED", finalBillNo: "IPB/26-27/000001", bed: null });
    // 14,200 − 200 discount − 8,000 advance = 6,000 collected
    expect(adm.bill).toMatchObject({ subtotal: 1_420_000, discount: 20_000, total: 1_400_000, paid: 1_400_000, balance: 0 });
    expect(adm.payments.at(-1)).toMatchObject({ kind: "FINAL", amount: 600_000, mode: "CARD", receiptNo: "IPR/26-27/000003" });

    await at(25, 9); // the bill of a discharged patient doesn't keep growing
    expect(ok<Admission>(await nurse.get(`/api/ipd/admissions/${adm.id}`)).bill.days).toBe(3);
    expect((await nurse.post(`/api/ipd/admissions/${adm.id}/notes`, { kind: "NURSING", text: "late" })).json().code).toBe("already_discharged");
    expect(bed((await board()).find((w) => w.id === icu.id)!, "ICU-1").state).toBe("CLEANING");
    const gone = ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions?status=DISCHARGED"));
    expect(gone.map((a) => [a.patient.name, a.dischargeType])).toEqual([["Meena Raj", "NORMAL"]]);
    expect(ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions"))).toEqual([]);
  });

  it("refunds unused advance on a short stay", async () => {
    await at(25, 9);
    let r = ok<Admission>(await admit(ravi, bed(general, "G2").id, { deposit: 1_000_000, reason: "Observation after fall" }), 201);
    r = ok(await doctor.put(`/api/ipd/admissions/${r.id}/summary`, { summaryVersion: 0, dischargeType: "LAMA", diagnoses: [{ text: "Head injury, observation" }], conditionAtDischarge: "Conscious, oriented" }));
    r = ok(await doctor.post(`/api/ipd/admissions/${r.id}/summary/sign`, { summaryVersion: 1 }));
    await at(25, 18);
    r = ok(await desk.post(`/api/ipd/admissions/${r.id}/discharge`, { paymentMode: "CASH", expectedSubtotal: 120_000, idempotencyKey: randomUUID() }));
    expect(r.bill).toMatchObject({ days: 1, total: 120_000, paid: 120_000, balance: 0 });
    expect(r.payments.at(-1)).toMatchObject({ kind: "REFUND", amount: 880_000 });
  });
});
