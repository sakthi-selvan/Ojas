import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  TestInput, ageBandText, interpret, pickRange,
  type DaySlots, type LabOrderDetail, type LabOrderSummary, type LabRequest, type LabTest, type OrderTest, type Patient, type PatientLabResult, type Practitioner, type Receipt,
} from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { makeApp, setupAdmin, userWithRole, type Client } from "./helpers.js";
import { STARTER_TESTS } from "../src/modules/lab/starter.js";

const NOW = new Date(2026, 10, 20, 9, 0);
let db: Db;
let server: FastifyInstance;
let admin: Client, tech: Client, doctor: Client, nurse: Client, reception: Client;
let patient: Patient;
let tests: Record<string, LabTest>;

const priced = async (code: string, price: number) => {
  const t = tests[code]!;
  const res = await tech.put(`/api/lab/tests/${t.id}`, { ...t, price });
  expect(res.statusCode, res.body).toBe(200);
  tests[code] = res.json();
};
const bill = (body: object, as: Client = tech) =>
  as.post("/api/lab/orders", { patientId: patient.id, paymentMode: "CASH", idempotencyKey: randomUUID(), ...body });
const testOf = (o: LabOrderDetail, code: string) => o.tests.find((t) => t.code === code)!;

beforeAll(async () => {
  ({ db, app: server } = await makeApp(() => NOW));
  admin = await setupAdmin(server);
  tech = (await userWithRole(server, admin, "LAB", "labtech")).client;
  doctor = (await userWithRole(server, admin, "DOCTOR", "drananya")).client;
  nurse = (await userWithRole(server, admin, "NURSE", "nurse1")).client;
  reception = (await userWithRole(server, admin, "RECEPTION", "desk1")).client;
  patient = (await admin.post("/api/patients", { name: "Meena Raj", sex: "F", phone: "9876501234", ageYears: 35 })).json();
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe("reference ranges", () => {
  const hb = TestInput.parse({
    code: "HB", name: "Haemoglobin", section: "HAEM", sampleType: "EDTA", price: 100,
    parameters: [{
      id: "hb", name: "Haemoglobin", unit: "g/dL", decimals: 1, criticalLow: 7,
      ranges: [{ sex: "M", low: 13, high: 17 }, { sex: "F", low: 12, high: 15 }, { ageFrom: 1, ageTo: 12, low: 11, high: 14 }],
    }],
  }).parameters[0]!;

  it("picks the child's range over the adult one, and the patient's sex over ANY", () => {
    expect(pickRange(hb.ranges, "M", 8)).toMatchObject({ low: 11, high: 14 });
    expect(pickRange(hb.ranges, "F", 30)).toMatchObject({ low: 12, high: 15 });
    expect(pickRange(hb.ranges, "M", null)).toMatchObject({ low: 13 });
  });

  it("flags low, high and critical values, and reads analyser limits like <0.5", () => {
    expect(interpret(hb, "11.2", "F", 30)).toMatchObject({ flag: "L", refText: "12.0 – 15.0" });
    expect(interpret(hb, "12.5", "M", 30)).toMatchObject({ flag: "L" });
    expect(interpret(hb, "6.1", "F", 30)).toMatchObject({ flag: "LL" });
    expect(interpret(hb, "13", "F", 30)).toMatchObject({ flag: null });
    expect(interpret(hb, ">20", "F", 30)).toMatchObject({ flag: "H" });
    expect(interpret(hb, "high", "F", 30)).toBeNull();
  });
});

describe("laboratory", () => {
  let order: LabOrderDetail;

  it("loads the starter catalogue once; unpriced tests can't be billed until priced", async () => {
    const first = await tech.post("/api/lab/tests/starter");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().added).toBeGreaterThan(15);
    expect((await tech.post("/api/lab/tests/starter")).json()).toMatchObject({ added: 0 });
    tests = Object.fromEntries(((await tech.get("/api/lab/tests")).json() as LabTest[]).map((t) => [t.code, t]));
    expect(tests.CBC!.parameters.map((p) => p.id)).toContain("hb");

    const unpriced = await bill({ testIds: [tests.CBC!.id] });
    expect(unpriced.statusCode).toBe(422);
    expect(unpriced.json().code).toBe("test_unpriced");

    await priced("CBC", 30000);
    await priced("FBS", 8000);
    await priced("LIPID", 50000);
    await priced("URINE", 15000);
    expect((await tech.get("/api/lab/tests?q=fasting")).json().map((t: LabTest) => t.code)).toContain("FBS");
  });

  it("only the lab may change the catalogue; a duplicate code is refused", async () => {
    expect((await reception.post("/api/lab/tests", { ...tests.CBC, code: "CBC2" })).statusCode).toBe(403);
    const dup = await tech.post("/api/lab/tests", { ...tests.CBC, name: "Another" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().details.fields).toHaveProperty("code");
  });

  it("bills an order (idempotently); reception can bill, a nurse can't, discounts need permission", async () => {
    const key = randomUUID();
    const body = { testIds: [tests.CBC!.id, tests.FBS!.id, tests.LIPID!.id], referredBy: "Dr. Ananya", idempotencyKey: key };
    const res = await bill(body);
    expect(res.statusCode, res.body).toBe(201);
    order = res.json();
    expect(order.orderNo).toBe("LAB/26-27/000001");
    expect(order.total).toBe(88000);
    expect(order.tests.map((t) => t.status)).toEqual(["ORDERED", "ORDERED", "ORDERED"]);
    expect(order.facility.name).toBeTruthy();
    expect((await bill(body)).json().id).toBe(order.id);

    expect((await bill({ testIds: [tests.URINE!.id] }, reception)).statusCode).toBe(201);
    expect((await bill({ testIds: [tests.URINE!.id] }, nurse)).statusCode).toBe(403);
    expect((await bill({ testIds: [tests.URINE!.id], discount: 1000 })).statusCode).toBe(403);
    expect((await bill({ testIds: [tests.URINE!.id], discount: 1000 }, admin)).json().total).toBe(14000);
  });

  it("results can't be entered before the sample is taken", async () => {
    const t = testOf(order, "CBC");
    const res = await tech.put(`/api/lab/results/${t.id}`, { values: { hb: "11" }, rowVersion: t.rowVersion });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("sample_not_collected");
  });

  it("collecting gives one accession number per sample type", async () => {
    const res = await tech.post(`/api/lab/orders/${order.id}/collect`, {});
    expect(res.statusCode, res.body).toBe(200);
    order = res.json();
    expect(order.samples.map((s) => s.accessionNo)).toEqual(["261120-001", "261120-002", "261120-003"]);
    expect(order.samples.map((s) => s.sampleType).sort()).toEqual(["EDTA", "FLUORIDE", "SERUM"]);
    expect(order.tests.every((t) => t.status === "COLLECTED" && t.accessionNo)).toBe(true);
    expect((await tech.post(`/api/lab/orders/${order.id}/collect`, {})).statusCode).toBe(409);
  });

  it("checks and flags values for this patient (a woman, 35); a stale screen can't overwrite", async () => {
    const cbc = testOf(order, "CBC");
    const bad = await tech.put(`/api/lab/results/${cbc.id}`, { values: { hb: "abc", tlc: "9000" }, rowVersion: cbc.rowVersion });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.fields).toHaveProperty("values.hb");

    const ok = await tech.put(`/api/lab/results/${cbc.id}`, { values: { hb: "6.4", tlc: "9000", plt: "" }, remarks: "Repeat advised", rowVersion: cbc.rowVersion });
    expect(ok.statusCode, ok.body).toBe(200);
    const saved = ok.json() as OrderTest;
    expect(saved.status).toBe("RESULTED");
    expect(saved.results).toEqual([
      { paramId: "hb", value: "6.4", flag: "LL", refText: "12.0 – 15.0" },
      { paramId: "tlc", value: "9000", flag: null, refText: "4000 – 11000" },
    ]);

    const stale = await tech.put(`/api/lab/results/${cbc.id}`, { values: { hb: "7" }, rowVersion: cbc.rowVersion });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("changed_elsewhere");

    const lipid = testOf(order, "LIPID");
    const l = (await tech.put(`/api/lab/results/${lipid.id}`, { values: { hdl: "45", tc: "180" }, rowVersion: lipid.rowVersion })).json() as OrderTest;
    expect(l.results.find((r) => r.paramId === "hdl")).toMatchObject({ flag: "L", refText: "Above 50" });

    const list = (await tech.get("/api/lab/orders?date=2026-11-20")).json() as LabOrderSummary[];
    expect(list.find((o) => o.id === order.id)!.critical).toBe(true);
  });

  it("verifying releases the result; changing it afterwards needs an amendment with a reason", async () => {
    const cbc = (await tech.get(`/api/lab/orders/${order.id}`)).json().tests.find((t: OrderTest) => t.code === "CBC") as OrderTest;
    expect((await nurse.post(`/api/lab/results/${cbc.id}/verify`, { rowVersion: cbc.rowVersion })).statusCode).toBe(403);
    const v = await tech.post(`/api/lab/results/${cbc.id}/verify`, { rowVersion: cbc.rowVersion });
    expect(v.statusCode, v.body).toBe(200);
    const verified = v.json() as OrderTest;
    expect(verified).toMatchObject({ status: "VERIFIED", verifiedBy: "LAB labtech" });

    expect((await tech.put(`/api/lab/results/${cbc.id}`, { values: { hb: "7" }, rowVersion: verified.rowVersion })).json().code).toBe("already_verified");
    expect((await tech.post(`/api/lab/results/${cbc.id}/amend`, { reason: "x" })).statusCode).toBe(400);
    const a = (await tech.post(`/api/lab/results/${cbc.id}/amend`, { reason: "Wrong sample value typed" })).json() as OrderTest;
    expect(a).toMatchObject({ status: "RESULTED", amendReason: "Wrong sample value typed", verifiedBy: null });
    const fixed = (await tech.put(`/api/lab/results/${cbc.id}`, { values: { hb: "10.4", tlc: "9000" }, rowVersion: a.rowVersion })).json() as OrderTest;
    expect(fixed.results[0]!.flag).toBe("L");
    expect((await tech.post(`/api/lab/results/${cbc.id}/verify`, { rowVersion: fixed.rowVersion })).json().status).toBe("VERIFIED");

    const audit = await db.query<{ data: { previous: { value: string }[] } }>("select data from core.audit_event where action = 'lab.result.amend'");
    expect(audit.rows[0]!.data.previous[0]!.value).toBe("6.4");
  });

  it("a rejected sample sends its tests back for a new sample; a verified one can't be rejected", async () => {
    let o = (await tech.get(`/api/lab/orders/${order.id}`)).json() as LabOrderDetail;
    const fbsSample = o.samples.find((s) => s.sampleType === "FLUORIDE")!;
    expect((await tech.post(`/api/lab/samples/${fbsSample.id}/reject`, { reason: "" })).statusCode).toBe(400);
    o = (await tech.post(`/api/lab/samples/${fbsSample.id}/reject`, { reason: "Haemolysed" })).json();
    expect(testOf(o, "FBS")).toMatchObject({ status: "ORDERED", accessionNo: null });
    expect(o.samples.find((s) => s.id === fbsSample.id)).toMatchObject({ rejectReason: "Haemolysed" });
    o = (await tech.post(`/api/lab/orders/${order.id}/collect`, { orderTestIds: [testOf(o, "FBS").id] })).json();
    expect(testOf(o, "FBS")).toMatchObject({ status: "COLLECTED", accessionNo: "261120-004" });

    const edta = o.samples.find((s) => s.sampleType === "EDTA")!;
    expect((await tech.post(`/api/lab/samples/${edta.id}/reject`, { reason: "Clotted" })).json().code).toBe("already_verified");
  });

  it("the doctor sees verified results only, and can't bill", async () => {
    const results = (await doctor.get(`/api/lab/patients/${patient.id}/results`)).json() as PatientLabResult[];
    expect(results.map((r) => r.name)).toEqual(["Complete blood count"]);
    expect(results[0]!.results[0]).toMatchObject({ paramId: "hb", value: "10.4" });
    expect((await bill({ testIds: [tests.CBC!.id] }, doctor)).statusCode).toBe(403);
  });

  it("tests ordered in a signed consultation wait at the lab, matched to the catalogue, until billed", async () => {
    const practitioner = ((await admin.get("/api/practitioners")).json() as Practitioner[]).find((p) => p.name.includes("Ananya"))!;
    const slot = ((await admin.get(`/api/practitioners/${practitioner.id}/slots?date=2026-11-20`)).json() as DaySlots).slots.find((s) => s.available)!;
    const appointmentId = ((await admin.post("/api/front-desk/checkout", {
      patientId: patient.id, practitionerId: practitioner.id, slotStart: slot.start, paymentMode: "CASH", idempotencyKey: randomUUID(),
    })).json() as Receipt).appointmentId;
    const saved = await doctor.put(`/api/consult/${appointmentId}/notes`, {
      notesVersion: 0, chiefComplaint: "Tiredness",
      labOrders: [{ test: "Complete blood count (CBC)" }, { test: "Fasting sugar", notes: "Come fasting" }, { test: "Chest X-ray" }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await doctor.post(`/api/consult/${appointmentId}/sign`)).statusCode).toBe(200);

    const reqs = (await tech.get("/api/lab/requests")).json() as LabRequest[];
    const mine = reqs.find((r) => r.appointmentId === appointmentId)!;
    expect(mine.patient.name).toBe("Meena Raj");
    expect(mine.lines.map((l) => [l.test, l.match?.code ?? null])).toEqual([
      ["Complete blood count (CBC)", "CBC"], ["Fasting sugar", "FBS"], ["Chest X-ray", null],
    ]);

    const other = (await admin.post("/api/patients", { name: "Arun Das", sex: "M", phone: "9876505678", ageYears: 50 })).json() as Patient;
    expect((await bill({ appointmentId, patientId: other.id, testIds: [tests.CBC!.id] })).statusCode).toBe(422);
    expect((await bill({ appointmentId, testIds: [tests.CBC!.id, tests.FBS!.id] })).statusCode).toBe(201);
    expect(((await tech.get("/api/lab/requests")).json() as LabRequest[]).some((r) => r.appointmentId === appointmentId)).toBe(false);
  });
});

describe("children's reference ranges", () => {
  const ok = <T = any>(res: { statusCode: number; body: string; json: () => unknown }): T => { expect(res.statusCode, res.body).toBe(200); return res.json() as T; };
  const starter = () => STARTER_TESTS.map((t) => TestInput.parse(t));
  const param = (code: string, id: string) => starter().find((t) => t.code === code)!.parameters.find((p) => p.id === id)! as never;
  const days = (n: number) => n / 365.25;

  it("the starter catalogue is valid, and reads a newborn, a toddler and a teenager against their own ranges", () => {
    expect(starter()).toHaveLength(STARTER_TESTS.length);
    // Hb 21 is normal at 3 days (not critical, as it would be for an adult), low at 4 years, normal for an adult woman's 12.5.
    expect(interpret(param("CBC", "hb"), "21", "M", days(3))).toMatchObject({ flag: null, refText: "14.5 – 22.5" });
    expect(interpret(param("CBC", "hb"), "21", "M", 40)!.flag).toBe("HH");
    expect(interpret(param("CBC", "hb"), "11", "F", 4)).toMatchObject({ flag: "L", refText: "11.5 – 13.5" });
    expect(interpret(param("CBC", "hb"), "12.5", "M", 15)).toMatchObject({ flag: "L", refText: "13.0 – 16.0" });
    // A newborn's glucose of 42 is low, not critical; 38 is critical.
    expect(interpret(param("FBS", "glu"), "42", "F", days(2))!.flag).toBe("L");
    expect(interpret(param("FBS", "glu"), "38", "F", days(2))!.flag).toBe("LL");
    // ALP of 300 is normal for a 7-year-old and high for an adult.
    expect(interpret(param("LFT", "alp"), "300", "M", 7)!.flag).toBeNull();
    expect(interpret(param("LFT", "alp"), "300", "M", 30)!.flag).toBe("H");
  });

  it("marks an adult range used for a child, and shows age bands in days, months and years", () => {
    expect(interpret(param("CBC", "lymph"), "60", "M", 3)).toMatchObject({ flag: "H", refText: "20 – 40 (adult range)" });
    expect(interpret(param("CBC", "lymph"), "30", "M", 30)!.refText).toBe("20 – 40");
    expect(ageBandText({ ageFrom: 0, ageTo: days(7) })).toBe("0–7 days");
    expect(ageBandText({ ageFrom: 1 / 12, ageTo: 0.5 })).toBe("1–6 months");
    expect(ageBandText({ ageFrom: days(7), ageTo: 1 / 12 })).toBe("7–30 days");
    expect(ageBandText({ ageFrom: 12, ageTo: null })).toBe("12 years and over");
    expect(ageBandText({ ageFrom: null, ageTo: null })).toBe("");
  });

  it("adds children's ranges to a catalogue loaded before them, without touching the lab's own age ranges", async () => {
    const cbc = ok<LabTest[]>(await tech.get("/api/lab/tests?q=CBC")).find((t) => t.code === "CBC")!;
    const adultOnly = cbc.parameters.map((p) => ({ ...p, ranges: p.ranges.filter((x) => x.ageFrom === null && x.ageTo === null) }));
    // The lab wrote its own children's MCV range; that one stays as it is.
    const mine = adultOnly.map((p) => (p.id === "mcv" ? { ...p, ranges: [...p.ranges, { sex: "ANY" as const, ageFrom: 0, ageTo: 18, low: 70, high: 100 }] } : p));
    ok(await tech.put(`/api/lab/tests/${cbc.id}`, { ...cbc, parameters: mine }));
    expect((await reception.post("/api/lab/tests/child-ranges", {})).statusCode).toBe(403);
    const res = ok<{ tests: number; parameters: number }>(await tech.post("/api/lab/tests/child-ranges", {}));
    expect(res.tests).toBeGreaterThanOrEqual(1);
    const after = ok<LabTest[]>(await tech.get("/api/lab/tests?q=CBC")).find((t) => t.code === "CBC")!;
    const hb = after.parameters.find((p) => p.id === "hb")!;
    expect(hb.ranges.filter((x) => x.ageTo !== null)).toHaveLength(10);
    expect(after.parameters.find((p) => p.id === "mcv")!.ranges.filter((x) => x.ageTo !== null)).toEqual([expect.objectContaining({ low: 70, high: 100 })]);
    // Running it again changes nothing.
    expect(ok<{ parameters: number }>(await tech.post("/api/lab/tests/child-ranges", {})).parameters).toBe(0);
  });
});
