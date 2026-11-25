import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { doseCounts, doseSlots, doseTiming, expandBeds, midnightsBetween, roomGstBp, type WardMeds, type Admission, type AdmissionSummary, type IpdService, type Patient, type Practitioner, type Ward } from "@ojas/shared";
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

describe("pharmacy and lab on the in-patient bill", () => {
  it("charges counter bills to the admission instead of taking payment, and settles them at discharge", async () => {
    await at(26, 9);
    const chemist = (await userWithRole(server, admin, "PHARMACY", "chem1")).client;
    const tech = (await userWithRole(server, admin, "LAB", "lab1")).client;
    const kumar = ok<Patient>(await admin.post("/api/patients", { name: "Kumar S", sex: "M", phone: "9876509999", ageYears: 60 }), 201);
    const a = ok<Admission>(await admit(kumar, bed(general, "G3").id, { deposit: 200_000 }), 201);

    // The counters see who is admitted.
    const inpatients = ok<{ admissionId: string; patient: { name: string }; bedLabel: string }[]>(await chemist.get("/api/ipd/inpatients"));
    expect(inpatients.map((x) => [x.patient.name, x.bedLabel])).toEqual([["Kumar S", "G3"]]);
    expect((await accounts.get("/api/ipd/inpatients")).statusCode).toBe(200);

    // Pharmacy: stock one medicine, then sell it onto the IP bill.
    const item = ok<{ id: string }>(await chemist.post("/api/pharmacy/items", { name: "Ceftriaxone", strength: "1 g", form: "INJ", packSize: 1, gstRate: 12 }), 201);
    const sup = ok<{ id: string }>(await chemist.post("/api/pharmacy/suppliers", { name: "City Pharma" }), 201);
    ok(await chemist.post("/api/pharmacy/purchases", {
      supplierId: sup.id, invoiceNo: "C-1", invoiceDate: "2026-11-25", idempotencyKey: randomUUID(),
      lines: [{ itemId: item.id, batchNo: "CF1", expiry: "2027-12", packs: 10, ratePerPack: 3000, mrpPerPack: 5_000, gstRate: 12 }],
    }), 201);
    const sale = (body: object) => chemist.post("/api/pharmacy/sales", {
      patientId: kumar.id, customerName: "Kumar S", lines: [{ itemId: item.id, qty: 3 }], paymentMode: "CASH", idempotencyKey: randomUUID(), ...body,
    });
    expect((await sale({ admissionId: a.id, patientId: meena.id })).json().code).toBe("wrong_patient");
    const ph = ok<{ paymentMode: string; admissionNo: string; total: number }>(await sale({ admissionId: a.id }), 201);
    expect(ph).toMatchObject({ paymentMode: "IPD", admissionNo: a.admissionNo, total: 15_000 });

    // Lab: a priced test billed onto the admission; the admitting doctor is the referrer.
    ok(await admin.post("/api/lab/tests/starter"));
    const full = (await admin.get("/api/lab/tests?q=cbc")).json()[0];
    ok(await admin.put(`/api/lab/tests/${full.id}`, { ...full, price: 30_000 }));
    const order = ok<{ paymentMode: string; referredBy: string; admissionNo: string }>(
      await tech.post("/api/lab/orders", { patientId: kumar.id, testIds: [full.id], paymentMode: "CASH", admissionId: a.id, idempotencyKey: randomUUID() }), 201);
    expect(order).toMatchObject({ paymentMode: "IPD", admissionNo: a.admissionNo, referredBy: doc.name });

    let now = ok<Admission>(await desk.get(`/api/ipd/admissions/${a.id}`));
    expect(now.bill.lines.filter((l) => l.category === "MEDICINE" || l.category === "INVESTIGATION").map((l) => [l.category, l.amount])).toEqual([["MEDICINE", 15_000], ["INVESTIGATION", 30_000]]);
    expect(now.bill.subtotal).toBe(120_000 + 15_000 + 30_000);

    // Settle and discharge: the counter bills are paid with everything else; afterwards they can't be added.
    now = ok(await doctor.put(`/api/ipd/admissions/${a.id}/summary`, { summaryVersion: 0, diagnoses: [{ text: "Cellulitis" }], conditionAtDischarge: "Better" }));
    now = ok(await doctor.post(`/api/ipd/admissions/${a.id}/summary/sign`, { summaryVersion: 1 }));
    now = ok(await desk.post(`/api/ipd/admissions/${a.id}/discharge`, { paymentMode: "CASH", expectedSubtotal: 165_000, idempotencyKey: randomUUID() }));
    expect(now.payments.at(-1)).toMatchObject({ kind: "REFUND", amount: 35_000 });
    expect((await sale({ admissionId: a.id })).json().code).toBe("already_discharged");
  });
});

describe("dose schedule", () => {
  const order = (frequency: string, startedAt: Date, doses: [Date, "GIVEN" | "HELD"][] = [], extra: object = {}) => ({
    id: "m", med: { drug: "X", dose: "", frequency, timing: "ANY" as const, route: "ORAL" as const, durationDays: null, instructions: "" },
    startedAt: startedAt.toISOString(), startedBy: "", stoppedAt: null, stoppedBy: null, stopReason: "",
    doses: doses.map(([d, status], i) => ({ id: String(i), status, note: "", at: d.toISOString(), by: "" })), ...extra,
  });
  const states = (m: ReturnType<typeof order>, now: Date) =>
    doseSlots(m, now).map((s) => `${new Date(s.at).getHours()}:${s.state}`);

  it("reads the usual frequencies as ward times", () => {
    expect(doseTiming("1-0-1")).toEqual({ kind: "times", hours: [8, 20] });
    expect(doseTiming("1-1-1-1")).toEqual({ kind: "times", hours: [8, 13, 18, 22] });
    expect(doseTiming(" tds ")).toEqual({ kind: "times", hours: [8, 14, 20] });
    expect(doseTiming("Q8H")).toEqual({ kind: "times", hours: [6, 14, 22] });
    expect(doseTiming("Stat")).toEqual({ kind: "once" });
    for (const f of ["SOS", "PRN", "Weekly", "", "as directed"]) expect(doseTiming(f)).toEqual({ kind: "as-needed" });
  });

  it("matches doses to their times; unrecorded times go overdue an hour after", () => {
    const m = order("TDS", new Date(2026, 10, 20, 7), [[new Date(2026, 10, 20, 8, 20), "GIVEN"], [new Date(2026, 10, 20, 15, 30), "HELD"]]);
    expect(states(m, new Date(2026, 10, 20, 19, 10))).toEqual(["8:DONE", "14:DONE", "20:DUE"]);
    expect(states(m, new Date(2026, 10, 20, 21, 5))).toEqual(["8:DONE", "14:DONE", "20:LATE"]);
    // A second dose close to the first is an extra, not a catch-up for an earlier gap.
    const twice = order("BD", new Date(2026, 10, 20, 7), [[new Date(2026, 10, 20, 20), "GIVEN"], [new Date(2026, 10, 20, 20, 30), "GIVEN"]]);
    expect(states(twice, new Date(2026, 10, 20, 22))).toEqual(["8:LATE", "20:DONE"]);
    // Ordered mid-morning: the 8 o'clock dose isn't expected; a stat dose is due at once.
    expect(states(order("BD", new Date(2026, 10, 20, 11)), new Date(2026, 10, 20, 12))).toEqual(["20:LATER"]);
    expect(states(order("Stat", new Date(2026, 10, 20, 11)), new Date(2026, 10, 20, 11, 30))).toEqual(["11:DUE"]);
    // The course ends after its days; as-needed medicines never go overdue.
    const twoDays = order("OD", new Date(2026, 10, 18, 7), [], { med: { ...order("OD", new Date()).med, durationDays: 2 } });
    expect(states(twoDays, new Date(2026, 10, 19, 12))).toEqual(["8:LATE"]);
    expect(states(twoDays, new Date(2026, 10, 20, 12))).toEqual([]);
    expect(doseSlots(order("SOS", new Date(2026, 10, 18, 7)), new Date(2026, 10, 20, 12))).toEqual([]);
  });

  it("lists the ward's running medicines for the dose round", async () => {
    await at(28, 7);
    const lata = ok<Patient>(await admin.post("/api/patients", { name: "Lata M", sex: "F", phone: "9876507777", ageYears: 70 }), 201);
    const free = (await board()).flatMap((w) => w.beds).find((b) => b.state === "FREE")!;
    const a = ok<Admission>(await admit(lata, free.id), 201);
    const cef = ok<Admission>(await doctor.post(`/api/ipd/admissions/${a.id}/meds`, { drug: "Inj. Ceftriaxone", dose: "1 g", frequency: "1-0-1", route: "IV" })).meds[0]!;
    ok(await doctor.post(`/api/ipd/admissions/${a.id}/meds`, { drug: "Pantoprazole", dose: "40 mg", frequency: "OD" }));
    ok(await doctor.post(`/api/ipd/admissions/${a.id}/meds`, { drug: "Paracetamol", dose: "650 mg", frequency: "SOS" }));
    await at(28, 8, 10);
    ok(await nurse.post(`/api/ipd/meds/${cef.id}/doses`, {}));
    await at(28, 21, 30);
    const round = ok<WardMeds[]>(await nurse.get("/api/ipd/doses"));
    const mine = round.find((r) => r.admissionId === a.id)!;
    expect(mine.meds.map((m) => m.med.drug)).toEqual(["Inj. Ceftriaxone", "Pantoprazole", "Paracetamol"]);
    expect(doseCounts(mine.meds, clock)).toEqual({ due: 0, late: 2 });
    expect((await (await userWithRole(server, admin, "PHARMACY", "chem2")).client.get("/api/ipd/doses")).statusCode).toBe(403);
  });
});

describe("correcting a summary after discharge", () => {
  it("keeps the old version with the reason, and the correcting doctor signs it", async () => {
    await at(29, 10);
    const done = ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions?status=DISCHARGED"));
    const a = ok<Admission>(await doctor.get(`/api/ipd/admissions/${done[0]!.id}`));
    const { summary } = a;
    const body = { ...summary!, diagnoses: [...summary!.diagnoses, { text: "Hypokalaemia", code: "E87.6" }], summaryVersion: a.summaryVersion };
    // Ordinary saving stays locked after discharge; an amendment needs a reason and the right version.
    expect((await doctor.put(`/api/ipd/admissions/${a.id}/summary`, body)).json().code).toBe("already_discharged");
    expect((await doctor.post(`/api/ipd/admissions/${a.id}/summary/amend`, body)).statusCode).toBe(400);
    expect((await nurse.post(`/api/ipd/admissions/${a.id}/summary/amend`, { ...body, reason: "Missed diagnosis" })).statusCode).toBe(403);
    expect((await doctor.post(`/api/ipd/admissions/${a.id}/summary/amend`, { ...body, summaryVersion: a.summaryVersion - 1, reason: "Missed diagnosis" })).json().code).toBe("changed_elsewhere");

    const b = ok<Admission>(await doctor.post(`/api/ipd/admissions/${a.id}/summary/amend`, { ...body, reason: "Added missed diagnosis from the potassium report" }));
    expect(b.summary!.diagnoses.map((d) => d.text)).toContain("Hypokalaemia");
    expect(b.summaryVersion).toBe(a.summaryVersion + 1);
    expect(b.summarySignedBy).toBe("DOCTOR drkavya");
    expect(b.amendments).toEqual([{ version: b.summaryVersion, at: clock.toISOString(), by: "DOCTOR drkavya", reason: "Added missed diagnosis from the potassium report" }]);
    const kept = (await db.query<{ previous: { diagnoses: unknown[] } }>("select previous from ipd.summary_amendment where admission_id = $1", [a.id])).rows[0]!;
    expect(kept.previous.diagnoses).toHaveLength(summary!.diagnoses.length);

    // Still admitted: amend isn't the way.
    const open = ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions?status=ADMITTED"));
    expect((await doctor.post(`/api/ipd/admissions/${open[0]!.id}/summary/amend`, { ...body, reason: "Wrong place" })).json().code).toBe("not_discharged");
  });
});

describe("GST on room rent", () => {
  it("taxes a non-ICU room over the daily limit on its whole rent, keeps each stay's rate, and shares the discount", async () => {
    await at(30, 10);
    const priv = ok<Ward>(await admin.post("/api/ipd/wards", { name: "Private", kind: "PRIVATE", bedCharge: 600_000, nursingCharge: 50_000, beds: ["P1", "P2"] }), 201);
    const p = ok<Patient>(await admin.post("/api/patients", { name: "Gita R", sex: "F", phone: "9876506666", ageYears: 45 }), 201);
    let a = ok<Admission>(await admit(p, bed(priv, "P1").id), 201);
    await at(32, 9);
    a = ok(await desk.get(`/api/ipd/admissions/${a.id}`));
    // ₹6,000 a day is over ₹5,000: 5% on the whole ₹12,000 of rent (not on nursing), split CGST + SGST.
    expect(a.bill.taxLines).toMatchObject([{ rent: 1_200_000, taxable: 1_200_000, ratePercent: 5, cgst: 30_000, sgst: 30_000, amount: 60_000 }]);
    expect(a.bill).toMatchObject({ subtotal: 1_300_000, tax: 60_000, total: 1_360_000, balance: 1_360_000 });

    // Raising the limit to ₹10,000 applies to stays that start afterwards, not to the nights already taxed.
    const f = ok<Record<string, unknown>>(await admin.get("/api/settings/facility"));
    expect(f).toMatchObject({ roomGstPercent: 5, roomGstAbove: 500_000 });
    const { setupCompleted: _s, hasPatients: _h, ...input } = f;
    ok(await admin.put("/api/settings/facility", { ...input, roomGstAbove: 1_000_000 }));
    ok(await desk.post(`/api/ipd/admissions/${a.id}/transfer`, { bedId: bed(priv, "P2").id, reason: "Patient asked for a quieter room" }));
    await at(33, 9);
    a = ok(await desk.get(`/api/ipd/admissions/${a.id}`));
    expect(a.bill.subtotal).toBe(1_950_000);
    expect(a.bill.taxLines.map((t) => [t.rent, t.amount])).toEqual([[1_200_000, 60_000]]);
    ok(await admin.put("/api/settings/facility", { ...input, roomGstAbove: 500_000 }));

    // A 10% discount lowers the taxable rent by 10% too: 5% of ₹10,800 = ₹540.
    a = ok(await doctor.put(`/api/ipd/admissions/${a.id}/summary`, { summaryVersion: 0, diagnoses: [{ text: "Acute gastroenteritis" }], conditionAtDischarge: "Well" }));
    a = ok(await doctor.post(`/api/ipd/admissions/${a.id}/summary/sign`, { summaryVersion: 1 }));
    a = ok(await accounts.post(`/api/ipd/admissions/${a.id}/discharge`, { discount: 195_000, paymentMode: "UPI", expectedSubtotal: 1_950_000, idempotencyKey: randomUUID() }));
    expect(a.bill).toMatchObject({ subtotal: 1_950_000, discount: 195_000, tax: 54_000, total: 1_809_000, paid: 1_809_000, balance: 0 });
    expect(a.bill.taxLines[0]).toMatchObject({ taxable: 1_080_000, cgst: 27_000, sgst: 27_000 });
    expect(a.payments.at(-1)).toMatchObject({ kind: "FINAL", amount: 1_809_000 });
  });

  it("never taxes ICU, and the rule is pure", () => {
    const rule = { bp: 500, above: 500_000 };
    expect(roomGstBp("ICU", 2_000_000, rule)).toBe(0);
    expect(roomGstBp("PRIVATE", 500_000, rule)).toBe(0);
    expect(roomGstBp("PRIVATE", 500_001, rule)).toBe(500);
    expect(roomGstBp("GENERAL", 900_000, { bp: 0, above: 0 })).toBe(0);
  });
});

describe("emergency (casualty) admission", () => {
  it("admits an unknown patient straight to a casualty bed, with no advance, and the doctor on duty can do it", async () => {
    await at(34, 2);
    const cas = ok<Ward>(await admin.post("/api/ipd/wards", { name: "Casualty", kind: "EMERGENCY", bedCharge: 80_000, beds: ["C1", "C2"] }), 201);
    const key = randomUUID();
    const body = {
      newPatient: { sex: "M", ageYears: 30 }, practitionerId: doc.id, bedId: bed(cas, "C1").id, reason: "Road accident, head injury, unconscious",
      mlc: true, policeStation: "Anna Nagar", broughtBy: "108 ambulance", idempotencyKey: key,
    };
    const a = ok<Admission>(await doctor.post("/api/ipd/emergency", body), 201);
    expect(a).toMatchObject({
      status: "ADMITTED", emergency: true, detailsPending: true, patient: { name: "Unknown man", phone: "", sex: "M" },
      mlc: { no: "", policeStation: "Anna Nagar", broughtBy: "108 ambulance" }, bed: { label: "C1", wardKind: "EMERGENCY" },
    });
    expect(a.payments).toEqual([]);
    // A double tap admits once.
    expect(ok<Admission>(await doctor.post("/api/ipd/emergency", body), 201).id).toBe(a.id);
    expect((await nurse.post("/api/ipd/emergency", { ...body, idempotencyKey: randomUUID() })).statusCode).toBe(403);

    const occ = (await board()).find((w) => w.id === cas.id)!.beds[0]!.occupant!;
    expect(occ).toMatchObject({ emergency: true, mlc: true, detailsPending: true });
    const listed = ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions")).find((x) => x.id === a.id)!;
    expect(listed).toMatchObject({ emergency: true, mlc: true });
  });

  it("completes the patient's registration and the police number later; a full registration can't be changed this way", async () => {
    const list = ok<AdmissionSummary[]>(await desk.get("/api/ipd/admissions"));
    const er = list.find((x) => x.emergency)!;
    expect((await desk.post(`/api/ipd/admissions/${er.id}/patient`, { name: "", sex: "M" })).statusCode).toBe(400);
    let a = ok<Admission>(await desk.post(`/api/ipd/admissions/${er.id}/patient`, { name: "suresh BABU", sex: "M", ageYears: 31, phone: "9876507777" }));
    expect(a).toMatchObject({ detailsPending: false, patient: { name: "Suresh Babu", phone: "9876507777" } });
    expect((await desk.post(`/api/ipd/admissions/${er.id}/patient`, { name: "Someone Else", sex: "M", ageYears: 31 })).json().code).toBe("details_complete");
    expect(ok<Patient[]>(await desk.get("/api/patients/search?q=9876507777"))[0]!.name).toBe("Suresh Babu");

    a = ok(await doctor.put(`/api/ipd/admissions/${er.id}/mlc`, { mlc: true, mlcNo: "MLC/112/26", policeStation: "Anna Nagar", broughtBy: "108 ambulance" }));
    expect(a.mlc).toEqual({ no: "MLC/112/26", policeStation: "Anna Nagar", broughtBy: "108 ambulance" });
    expect((await accounts.put(`/api/ipd/admissions/${er.id}/mlc`, { mlc: false })).statusCode).toBe(403);
  });

  it("admits a known patient through casualty; a named walk-in with a phone and age needs no completing", async () => {
    await at(34, 3);
    const cas = (await board()).find((w) => w.kind === "EMERGENCY")!;
    const known = ok<Patient>(await admin.post("/api/patients", { name: "Lakshmi N", sex: "F", phone: "9876508888", ageYears: 60 }), 201);
    const a = ok<Admission>(await desk.post("/api/ipd/emergency", { patientId: known.id, practitionerId: doc.id, bedId: bed(cas, "C2").id, reason: "Chest pain", idempotencyKey: randomUUID() }), 201);
    expect(a).toMatchObject({ emergency: true, detailsPending: false, mlc: null, patient: { id: known.id } });
    const res = await desk.post("/api/ipd/emergency", { practitionerId: doc.id, bedId: bed(general, "G3").id, reason: "Fall", idempotencyKey: randomUUID() });
    expect(res.statusCode).toBe(400);
  });
});
