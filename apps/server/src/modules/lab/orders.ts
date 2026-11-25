/**
 * Laboratory work: the lab bill (an order), sample collection with accession numbers, result
 * entry with flags, verification (release), corrections, and the requests coming from today's
 * consultations.
 *
 * A test moves ORDERED → COLLECTED → RESULTED → VERIFIED. Only verified results reach the report
 * and the doctor's screen; a verified result is changed only through "amend", which needs a reason.
 */
import {
  AmendInput, CollectInput, LabBillInput, RejectSampleInput, ResultsInput, VerifyInput, ageYears, interpret, isCritical,
  type LabOrderDetail, type LabOrderSummary, type LabPatient, type LabRequest, type LabResult, type LabSample, type OrderTest, type Parameter, type PatientLabResult,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { atLocal, localDate } from "../../core/clock.js";
import { financialYear, nextNumber } from "../../core/numbering.js";
import { getTest, matchTest } from "./catalog.js";
import { chargeTo } from "../ipd/admissions.js";

const dayRange = (from: string, to = from): [string, string] => {
  const end = atLocal(to, "00:00");
  end.setDate(end.getDate() + 1);
  return [atLocal(from, "00:00").toISOString(), end.toISOString()];
};

async function remembered<T>(q: Queryable, key: string): Promise<T | undefined> {
  return (await q.query<{ response: T }>("select response from core.idempotency where key = $1", [key])).rows[0]?.response;
}

// ───────────────────────── Reading ─────────────────────────

interface TestRow {
  id: string; order_id: string; test_id: string; code: string; name: string; section: OrderTest["section"]; sample_type: OrderTest["sampleType"];
  method: string; notes: string; price: number; status: OrderTest["status"]; parameters: Parameter[]; results: LabResult[]; remarks: string;
  accession_no: string | null; entered_at: string | null; entered_by: string | null; verified_at: string | null; verified_by_name: string | null;
  amend_reason: string | null; row_version: number; due_at: string;
}

const TEST_SELECT = `
  select t.*, s.accession_no, coalesce(u.display_name, t.verified_by) as verified_by_name
    from lab.order_test t
    left join lab.sample s on s.id = t.sample_id
    left join core.app_user u on u.username = t.verified_by`;

const toTest = (r: TestRow): OrderTest => ({
  id: r.id, testId: r.test_id, code: r.code, name: r.name, section: r.section, sampleType: r.sample_type, method: r.method, notes: r.notes,
  price: r.price, status: r.status, parameters: r.parameters, results: r.results, remarks: r.remarks, accessionNo: r.accession_no,
  enteredAt: r.entered_at, enteredBy: r.entered_by, verifiedAt: r.verified_at, verifiedBy: r.verified_at ? r.verified_by_name : null,
  amendReason: r.amend_reason, rowVersion: r.row_version, dueAt: r.due_at,
});

interface OrderRow {
  id: string; order_no: string; ordered_at: string; appointment_id: string | null; referred_by: string; subtotal: number; discount: number; total: number;
  payment_mode: LabOrderDetail["paymentMode"]; billed_by: string; admission_id: string | null; admission_no: string | null;
  p_id: string; uhid: string; p_name: string; sex: LabPatient["sex"]; dob: string | null; phone: string;
}

const ORDER_SELECT = `
  select o.*, coalesce(u.display_name, o.created_by) as billed_by, (select a.admission_no from ipd.admission a where a.id = o.admission_id) as admission_no,
         p.id as p_id, p.uhid, p.name as p_name, p.sex, p.dob, p.phone
    from lab.lab_order o
    join core.patient p on p.id = o.patient_id
    left join core.app_user u on u.username = o.created_by`;

const patientOf = (r: OrderRow): LabPatient => ({ id: r.p_id, uhid: r.uhid, name: r.p_name, sex: r.sex, dob: r.dob, phone: r.phone });
const anyCritical = (tests: { results: LabResult[] }[]) => tests.some((t) => t.results.some((x) => isCritical(x.flag)));

export async function getOrder(q: Queryable, id: string): Promise<LabOrderDetail> {
  const o = (await q.query<OrderRow>(`${ORDER_SELECT} where o.id = $1`, [id])).rows[0];
  if (!o) throw new AppError(404, "order_not_found", "Lab order not found");
  const tests = (await q.query<TestRow>(`${TEST_SELECT} where t.order_id = $1 order by t.line_no`, [id])).rows.map(toTest);
  const samples = (await q.query<{ id: string; accession_no: string; sample_type: LabSample["sampleType"]; collected_at: string; collected_by: string; rejected_at: string | null; reject_reason: string }>(
    "select * from lab.sample where order_id = $1 order by collected_at, accession_no", [id],
  )).rows.map((s): LabSample => ({
    id: s.id, accessionNo: s.accession_no, sampleType: s.sample_type, collectedAt: s.collected_at, collectedBy: s.collected_by, rejectedAt: s.rejected_at, rejectReason: s.reject_reason,
  }));
  const facility = (await q.query<LabOrderDetail["facility"]>("select name, address, phone, gstin from core.facility where id = 1")).rows[0]!;
  return {
    id: o.id, orderNo: o.order_no, orderedAt: o.ordered_at, appointmentId: o.appointment_id, patient: patientOf(o), referredBy: o.referred_by,
    subtotal: o.subtotal, discount: o.discount, total: o.total, paymentMode: o.payment_mode, admissionId: o.admission_id, admissionNo: o.admission_no, billedBy: o.billed_by,
    tests, samples, facility, critical: anyCritical(tests),
  };
}

/** The day's orders; on today's list, anything older that isn't finished yet comes too. */
export async function listOrders(q: Queryable, date: string, now = new Date()): Promise<LabOrderSummary[]> {
  const [from, to] = dayRange(date);
  const carryOver = date === localDate(now);
  const { rows } = await q.query<OrderRow>(
    `${ORDER_SELECT}
      where (o.ordered_at >= $1::timestamptz and o.ordered_at < $2::timestamptz)
         or ($3 and o.ordered_at >= $1::timestamptz - interval '30 days'
             and exists (select 1 from lab.order_test t where t.order_id = o.id and t.status <> 'VERIFIED'))
      order by o.ordered_at desc`,
    [from, to, carryOver],
  );
  if (!rows.length) return [];
  const tests = (await q.query<TestRow>(`${TEST_SELECT} where t.order_id = any($1::uuid[]) order by t.line_no`, [rows.map((r) => r.id)])).rows;
  return rows.map((o) => {
    const mine = tests.filter((t) => t.order_id === o.id);
    return {
      id: o.id, orderNo: o.order_no, orderedAt: o.ordered_at, patient: patientOf(o), referredBy: o.referred_by, total: o.total,
      tests: mine.map((t) => ({ id: t.id, code: t.code, name: t.name, status: t.status, sampleType: t.sample_type, accessionNo: t.accession_no, dueAt: t.due_at })),
      critical: anyCritical(mine),
    };
  });
}

// ───────────────────────── Billing ─────────────────────────

export async function billOrder(db: Db, actor: Actor, raw: unknown, now = new Date(), opts: { allowDiscount?: boolean } = {}): Promise<LabOrderDetail> {
  const v = LabBillInput.parse(raw);
  if (v.discount > 0 && !opts.allowDiscount) {
    throw new AppError(403, "discount_not_allowed", "You don't have permission to give discounts. Ask an administrator.");
  }
  const prev = await remembered<LabOrderDetail>(db, v.idempotencyKey);
  if (prev) return prev;
  try {
    return await db.tx(async (q) => {
      if (!(await q.query("select 1 from core.patient where id = $1", [v.patientId])).rows[0]) {
        throw new AppError(422, "patient_not_found", "Patient not found", { fields: { patientId: "Choose the patient" } });
      }
      if (v.appointmentId && !(await q.query("select 1 from core.appointment where id = $1 and patient_id = $2", [v.appointmentId, v.patientId])).rows[0]) {
        throw new AppError(422, "appointment_not_found", "That consultation is not this patient's");
      }
      const ip = v.admissionId ? await chargeTo(q, v.admissionId, v.patientId) : null;
      const mode = ip ? "IPD" : v.paymentMode;
      const ids = [...new Set(v.testIds)];
      const tests = [];
      for (const id of ids) {
        const t = await getTest(q, id);
        if (!t.active) throw new AppError(422, "test_inactive", `${t.name} is no longer offered`);
        if (t.price <= 0) throw new AppError(422, "test_unpriced", `${t.name} has no price yet. Set it under Tests first.`, { fields: { testIds: "Has no price" } });
        tests.push(t);
      }
      const subtotal = tests.reduce((s, t) => s + t.price, 0);
      if (v.discount > subtotal) throw new AppError(422, "discount_too_large", "Discount can't be more than the bill", { fields: { discount: "More than the bill" } });

      const id = uuidv7();
      const fy = financialYear(now);
      const orderNo = `LAB/${fy}/${String(await nextNumber(q, `lab-order:${fy}`)).padStart(6, "0")}`;
      await q.query(
        `insert into lab.lab_order (id, order_no, ordered_at, patient_id, appointment_id, referred_by, subtotal, discount, total, payment_mode, admission_id, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, orderNo, now.toISOString(), v.patientId, v.appointmentId ?? null, v.referredBy || ip?.doctorName || "", subtotal, v.discount, subtotal - v.discount, mode, v.admissionId ?? null, actor.user],
      );
      for (const [i, t] of tests.entries()) {
        const due = new Date(now.getTime() + t.tatHours * 3600_000);
        await q.query(
          `insert into lab.order_test (id, order_id, line_no, test_id, code, name, section, sample_type, method, notes, parameters, price, due_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
          [uuidv7(), id, i + 1, t.id, t.code, t.name, t.section, t.sampleType, t.method, t.notes, JSON.stringify(t.parameters), t.price, due.toISOString()],
        );
      }
      await audit(q, actor, "lab.order", "lab_order", id, {
        orderNo, patient: v.patientId, tests: tests.map((t) => t.code), total: subtotal - v.discount, discount: v.discount, mode, admission: ip?.admissionNo,
      });
      const order = await getOrder(q, id);
      await q.query("insert into core.idempotency (key, response) values ($1, $2::jsonb)", [v.idempotencyKey, JSON.stringify(order)]);
      return order;
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotency_pkey")) {
      const again = await remembered<LabOrderDetail>(db, v.idempotencyKey);
      if (again) return again;
    }
    throw e;
  }
}

// ───────────────────────── Samples ─────────────────────────

/** Records the samples taken: one container (and accession number) per sample type. */
export async function collect(db: Db, actor: Actor, orderId: string, raw: unknown, now = new Date()): Promise<LabOrderDetail> {
  const v = CollectInput.parse(raw ?? {});
  return db.tx(async (q) => {
    if (!(await q.query("select 1 from lab.lab_order where id = $1 for update", [orderId])).rows[0]) throw new AppError(404, "order_not_found", "Lab order not found");
    const { rows } = await q.query<{ id: string; sample_type: string }>(
      `select id, sample_type from lab.order_test where order_id = $1 and status = 'ORDERED' and ($2::uuid[] is null or id = any($2::uuid[])) order by line_no for update`,
      [orderId, v.orderTestIds ?? null],
    );
    if (!rows.length) throw new AppError(409, "nothing_to_collect", "These samples have already been taken");
    const day = localDate(now).slice(2).replace(/-/g, "");
    const byType = new Map<string, string[]>();
    for (const r of rows) byType.set(r.sample_type, [...(byType.get(r.sample_type) ?? []), r.id]);
    const taken: string[] = [];
    for (const [type, ids] of byType) {
      const sampleId = uuidv7();
      const accessionNo = `${day}-${String(await nextNumber(q, `lab-sample:${day}`)).padStart(3, "0")}`;
      await q.query(
        "insert into lab.sample (id, accession_no, order_id, sample_type, collected_at, collected_by) values ($1,$2,$3,$4,$5,$6)",
        [sampleId, accessionNo, orderId, type, now.toISOString(), actor.user],
      );
      await q.query(
        "update lab.order_test set status = 'COLLECTED', sample_id = $2, row_version = row_version + 1 where id = any($1::uuid[])",
        [ids, sampleId],
      );
      taken.push(accessionNo);
    }
    await audit(q, actor, "lab.collect", "lab_order", orderId, { samples: taken });
    return getOrder(q, orderId);
  });
}

/** A sample that can't be tested (haemolysed, clotted, too little): its tests go back to "sample due" for a new one. */
export async function rejectSample(db: Db, actor: Actor, sampleId: string, raw: unknown, now = new Date()): Promise<LabOrderDetail> {
  const v = RejectSampleInput.parse(raw);
  return db.tx(async (q) => {
    const s = (await q.query<{ order_id: string; accession_no: string; rejected_at: string | null }>(
      "select order_id, accession_no, rejected_at from lab.sample where id = $1 for update", [sampleId],
    )).rows[0];
    if (!s) throw new AppError(404, "sample_not_found", "Sample not found");
    if (s.rejected_at) throw new AppError(409, "sample_rejected", "This sample has already been rejected");
    const verified = (await q.query("select 1 from lab.order_test where sample_id = $1 and status = 'VERIFIED'", [sampleId])).rows[0];
    if (verified) throw new AppError(409, "already_verified", "A result from this sample has been verified. Amend that result instead.");
    await q.query(
      `update lab.order_test set status = 'ORDERED', sample_id = null, results = '[]', remarks = '', entered_at = null, entered_by = null,
              row_version = row_version + 1 where sample_id = $1`,
      [sampleId],
    );
    await q.query("update lab.sample set rejected_at = $2, rejected_by = $3, reject_reason = $4 where id = $1", [sampleId, now.toISOString(), actor.user, v.reason]);
    await audit(q, actor, "lab.sample.reject", "lab_sample", sampleId, { accessionNo: s.accession_no, reason: v.reason });
    return getOrder(q, s.order_id);
  });
}

// ───────────────────────── Results ─────────────────────────

interface LockedTest extends TestRow { sex: LabPatient["sex"]; dob: string | null; ordered_at: string }

async function lockTest(q: Queryable, id: string): Promise<LockedTest> {
  const r = (await q.query<LockedTest>(
    `select t.*, null as accession_no, null as verified_by_name, p.sex, p.dob, o.ordered_at
       from lab.order_test t join lab.lab_order o on o.id = t.order_id join core.patient p on p.id = o.patient_id
      where t.id = $1 for update of t`,
    [id],
  )).rows[0];
  if (!r) throw new AppError(404, "test_not_found", "Test not found");
  return r;
}

const reload = async (q: Queryable, id: string) => toTest((await q.query<TestRow>(`${TEST_SELECT} where t.id = $1`, [id])).rows[0]!);
const stale = () => new AppError(409, "changed_elsewhere", "Someone else changed these results. Reload to see the latest before saving.");

/** Saves the values typed so far (any time before verification). Each value is checked and flagged for this patient. */
export async function saveResults(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<OrderTest> {
  const v = ResultsInput.parse(raw);
  return db.tx(async (q) => {
    const t = await lockTest(q, id);
    if (t.status === "ORDERED") throw new AppError(409, "sample_not_collected", "Collect the sample before entering results");
    if (t.status === "VERIFIED") throw new AppError(409, "already_verified", "This result has been verified. Amend it to make a change.");
    if (t.row_version !== v.rowVersion) throw stale();
    const age = ageYears(t.dob, new Date(t.ordered_at));
    const results: LabResult[] = [];
    const fields: Record<string, string> = {};
    for (const p of t.parameters) {
      const value = (v.values[p.id] ?? "").trim();
      if (!value) continue;
      const r = interpret(p, value, t.sex, age);
      if (!r) fields[`values.${p.id}`] = "Enter a number";
      else results.push(r);
    }
    if (Object.keys(fields).length) throw new AppError(422, "validation_failed", "Some values aren't numbers", { fields });
    await q.query(
      `update lab.order_test set results = $2::jsonb, remarks = $3, status = $4, entered_at = $5, entered_by = $6, row_version = row_version + 1 where id = $1`,
      [id, JSON.stringify(results), v.remarks, results.length ? "RESULTED" : "COLLECTED", now.toISOString(), actor.user],
    );
    await audit(q, actor, "lab.result.save", "lab_test", id, { code: t.code, values: results.length, critical: results.filter((r) => isCritical(r.flag)).map((r) => r.paramId) });
    return reload(q, id);
  });
}

/** Releases a result: it goes on the report and to the doctor. */
export async function verify(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<OrderTest> {
  const v = VerifyInput.parse(raw);
  return db.tx(async (q) => {
    const t = await lockTest(q, id);
    if (t.status === "VERIFIED") throw new AppError(409, "already_verified", "Already verified");
    if (t.status !== "RESULTED" || !t.results.length) throw new AppError(409, "no_results", "Enter the results before verifying");
    if (t.row_version !== v.rowVersion) throw stale();
    await q.query(
      "update lab.order_test set status = 'VERIFIED', verified_at = $2, verified_by = $3, row_version = row_version + 1 where id = $1",
      [id, now.toISOString(), actor.user],
    );
    await audit(q, actor, "lab.result.verify", "lab_test", id, { code: t.code, results: t.results, remarks: t.remarks });
    return reload(q, id);
  });
}

/** Reopens a verified result for correction. The verified values stay in the audit trail. */
export async function amend(db: Db, actor: Actor, id: string, raw: unknown): Promise<OrderTest> {
  const v = AmendInput.parse(raw);
  return db.tx(async (q) => {
    const t = await lockTest(q, id);
    if (t.status !== "VERIFIED") throw new AppError(409, "not_verified", "Only a verified result needs amending; edit it directly");
    await q.query(
      "update lab.order_test set status = 'RESULTED', amend_reason = $2, verified_at = null, verified_by = null, row_version = row_version + 1 where id = $1",
      [id, v.reason],
    );
    await audit(q, actor, "lab.result.amend", "lab_test", id, { code: t.code, reason: v.reason, previous: t.results, verifiedBy: t.verified_by_name });
    return reload(q, id);
  });
}

// ───────────────────────── From consultations, and back to the doctor ─────────────────────────

/** Signed consultations from the last 3 days with tests ordered and no lab bill yet. */
export async function pendingRequests(q: Queryable, now = new Date()): Promise<LabRequest[]> {
  const since = new Date(atLocal(localDate(now), "00:00").getTime() - 2 * 86400_000).toISOString();
  const { rows } = await q.query<{ appointment_id: string; signed_at: string; encounter_id: string; d_name: string; p_id: string; uhid: string; p_name: string; sex: LabPatient["sex"]; dob: string | null; phone: string }>(
    `select e.appointment_id, e.signed_at, e.id as encounter_id, d.name as d_name, p.id as p_id, p.uhid, p.name as p_name, p.sex, p.dob, p.phone
       from core.encounter e
       join core.patient p on p.id = e.patient_id
       join core.practitioner d on d.id = e.practitioner_id
      where e.status = 'SIGNED' and e.signed_at >= $1::timestamptz
        and exists (select 1 from core.encounter_lab_order l where l.encounter_id = e.id)
        and not exists (select 1 from lab.lab_order o where o.appointment_id = e.appointment_id)
      order by e.signed_at`,
    [since],
  );
  const out: LabRequest[] = [];
  for (const r of rows) {
    const orders = (await q.query<{ test: string; notes: string }>("select test, notes from core.encounter_lab_order where encounter_id = $1 order by line_no", [r.encounter_id])).rows;
    const lines = [];
    for (const o of orders) lines.push({ test: o.test, notes: o.notes, match: await matchTest(q, o.test) });
    out.push({
      appointmentId: r.appointment_id, signedAt: r.signed_at, prescriber: r.d_name, lines,
      patient: { id: r.p_id, uhid: r.uhid, name: r.p_name, sex: r.sex, dob: r.dob, phone: r.phone },
    });
  }
  return out;
}

/** A patient's verified results, newest first, for the doctor's screen. */
export async function patientResults(q: Queryable, patientId: string, limit = 30): Promise<PatientLabResult[]> {
  const { rows } = await q.query<{ order_id: string; order_no: string; ordered_at: string; verified_at: string; name: string; parameters: Parameter[]; results: LabResult[]; remarks: string }>(
    `select t.order_id, o.order_no, o.ordered_at, t.verified_at, t.name, t.parameters, t.results, t.remarks
       from lab.order_test t join lab.lab_order o on o.id = t.order_id
      where o.patient_id = $1 and t.status = 'VERIFIED'
      order by t.verified_at desc limit $2`,
    [patientId, limit],
  );
  return rows.map((r) => ({
    orderId: r.order_id, orderNo: r.order_no, orderedAt: r.ordered_at, verifiedAt: r.verified_at, name: r.name, parameters: r.parameters, results: r.results, remarks: r.remarks,
  }));
}
