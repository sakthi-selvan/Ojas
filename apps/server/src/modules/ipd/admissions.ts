/**
 * In-patient admissions: admit to a bed (with an advance), move beds, the bedside chart (vitals,
 * notes, the treatment chart and each dose), charges and deposits, the discharge summary, and the
 * final settlement that discharges the patient and frees the bed for cleaning.
 *
 * Once discharged, an admission is read-only.
 */
import {
  AdmitInput, AmendSummaryInput, EmergencyAdmitInput, MlcInput, CancelChargeInput, ChargeInput, DepositInput, DoseInput, MedOrderInput, NoteInput, SettleInput, StopMedInput, SummaryInput, TransferInput,
  VITAL_KEYS, VitalsInput, formatINR, midnightsBetween, roomGstBp, roomTax, taxOf,
  type Admission, type AdmissionSummary, type BedStay, type BillLine, type Charge, type ChartNote, type DischargeSummary, type DoseEntry, type Inpatient, type SummaryAmendment, type WardMeds, type IpdBill,
  type IpdPayment, type IpdPaymentKind, type MedOrder, type NoteKind, type Vitals, type VitalsEntry,
} from "@ojas/shared";
import type { z } from "zod";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { financialYear, nextNumber } from "../../core/numbering.js";
import { completePatient, registerEmergencyPatient } from "../front-desk/patients.js";

const nameOf = (col: string) => `coalesce((select u.display_name from core.app_user u where u.username = ${col}), ${col})`;

async function remembered<T>(q: Queryable, key: string): Promise<T | undefined> {
  return (await q.query<{ response: T }>("select response from core.idempotency where key = $1", [key])).rows[0]?.response;
}

/** Runs `fn` once per idempotency key; a retry (double click, network blip) gets the first answer. */
async function once<T>(db: Db, key: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const prev = await remembered<T>(db, key);
  if (prev) return prev;
  try {
    return await db.tx(async (q) => {
      const out = await fn(q);
      await q.query("insert into core.idempotency (key, response) values ($1, $2::jsonb)", [key, JSON.stringify(out)]);
      return out;
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotency_pkey")) {
      const again = await remembered<T>(db, key);
      if (again) return again;
    }
    throw e;
  }
}

const seq = async (q: Queryable, prefix: string, now: Date) => {
  const fy = financialYear(now);
  return `${prefix}/${fy}/${String(await nextNumber(q, `${prefix.toLowerCase()}:${fy}`)).padStart(6, "0")}`;
};

// ───────────────────────── The bill ─────────────────────────

interface StayRow { bed_id: string; ward_name: string; ward_kind: BedStay["wardKind"]; bed_label: string; bed_charge: number; nursing_charge: number; gst_bp: number; from_at: string; to_at: string | null; reason: string }

/** Room and nursing by the midnight census, then the itemised charges; payments less refunds. */
export function computeBill(admittedAt: Date, end: Date, stays: StayRow[], charges: Charge[], payments: IpdPayment[], discount: number, counter: BillLine[] = []): IpdBill {
  const nights = new Map<number, number>();
  const mids = midnightsBetween(admittedAt, end);
  if (!mids.length) nights.set(stays.length - 1, 1);
  for (const m of mids) {
    const t = m.getTime();
    let i = stays.findIndex((s) => new Date(s.from_at).getTime() <= t && (!s.to_at || new Date(s.to_at).getTime() > t));
    if (i < 0) i = stays.length - 1;
    nights.set(i, (nights.get(i) ?? 0) + 1);
  }
  const lines: BillLine[] = [];
  const taxed: { stay: StayRow; rent: number; nights: number }[] = [];
  for (const [i, s] of stays.entries()) {
    const n = nights.get(i);
    if (!n) continue;
    if (s.gst_bp > 0 && s.bed_charge > 0) taxed.push({ stay: s, rent: n * s.bed_charge, nights: n });
    if (s.bed_charge > 0) lines.push({ category: "BED", description: `${s.ward_name} · bed ${s.bed_label}`, quantity: n, unitPrice: s.bed_charge, amount: n * s.bed_charge });
    if (s.nursing_charge > 0) lines.push({ category: "NURSING", description: `Nursing · ${s.ward_name}`, quantity: n, unitPrice: s.nursing_charge, amount: n * s.nursing_charge });
  }
  for (const c of charges) {
    if (!c.cancelledAt) lines.push({ category: c.category, description: c.description, quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount });
  }
  lines.push(...counter);
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const paid = payments.reduce((s, p) => s + (p.kind === "REFUND" ? -p.amount : p.amount), 0);
  const taxLines = roomTax(taxed.map(({ stay: s, rent, nights: n }) => ({
    description: `Room rent: ${s.ward_name} bed ${s.bed_label}, ${n} day${n === 1 ? "" : "s"} at ${formatINR(s.bed_charge)}`, rent, bp: s.gst_bp,
  })), subtotal, discount);
  const tax = taxOf(taxLines);
  const total = subtotal - discount + tax;
  return { days: Math.max(1, mids.length), lines, subtotal, discount, taxLines, tax, total, paid, balance: total - paid };
}

/** Pharmacy and lab bills put on this admission at their counters. */
async function counterLines(q: Queryable, admissionId: string): Promise<BillLine[]> {
  const ph = (await q.query<{ bill_no: string; total: number; items: number }>(
    `select s.bill_no, s.total, (select count(*)::int from pharmacy.sale_line l where l.sale_id = s.id) as items
       from pharmacy.sale s where s.admission_id = $1 order by s.issued_at`, [admissionId],
  )).rows.map((s): BillLine => ({ category: "MEDICINE", description: `Pharmacy bill ${s.bill_no} (${s.items} item${s.items === 1 ? "" : "s"})`, quantity: 1, unitPrice: s.total, amount: s.total }));
  const lab = (await q.query<{ order_no: string; total: number; codes: string }>(
    `select o.order_no, o.total, (select string_agg(t.code, ', ' order by t.line_no) from lab.order_test t where t.order_id = o.id) as codes
       from lab.lab_order o where o.admission_id = $1 order by o.ordered_at`, [admissionId],
  )).rows.map((o): BillLine => ({ category: "INVESTIGATION", description: `Lab ${o.order_no}: ${o.codes}`, quantity: 1, unitPrice: o.total, amount: o.total }));
  return [...ph, ...lab];
}

/**
 * Checks a counter bill (pharmacy, lab) can go on this admission, and locks the admission so the
 * bill can't be settled while the counter bill is being written.
 */
export async function chargeTo(q: Queryable, admissionId: string, patientId: string | undefined): Promise<{ admissionNo: string; doctorName: string }> {
  const a = (await q.query<{ status: string; patient_id: string; admission_no: string; doctor_name: string }>(
    `select a.status, a.patient_id, a.admission_no, d.name as doctor_name
       from ipd.admission a join core.practitioner d on d.id = a.practitioner_id where a.id = $1 for update of a`, [admissionId],
  )).rows[0];
  if (!a) throw new AppError(422, "admission_not_found", "That admission was not found", { fields: { admissionId: "Choose again" } });
  if (a.status !== "ADMITTED") throw new AppError(409, "already_discharged", `${a.admission_no} has been discharged; take payment at the counter instead`);
  if (patientId && patientId !== a.patient_id) throw new AppError(422, "wrong_patient", "That admission is for a different patient");
  return { admissionNo: a.admission_no, doctorName: a.doctor_name };
}

/** Everyone in a bed now, for the pharmacy and lab counters. */
export async function listInpatients(q: Queryable): Promise<Inpatient[]> {
  const { rows } = await q.query<{ id: string; admission_no: string; p_id: string; uhid: string; p_name: string; sex: Inpatient["patient"]["sex"]; dob: string | null; phone: string; ward_name: string; bed_label: string; doctor_name: string }>(
    `select a.id, a.admission_no, p.id as p_id, p.uhid, p.name as p_name, p.sex, p.dob, p.phone, w.name as ward_name, b.label as bed_label, d.name as doctor_name
       from ipd.admission a join core.patient p on p.id = a.patient_id join ipd.bed b on b.id = a.bed_id join ipd.ward w on w.id = b.ward_id
       join core.practitioner d on d.id = a.practitioner_id
      where a.status = 'ADMITTED' order by w.name, b.sort_no`,
  );
  return rows.map((r) => ({
    admissionId: r.id, admissionNo: r.admission_no, patient: { id: r.p_id, uhid: r.uhid, name: r.p_name, sex: r.sex, dob: r.dob, phone: r.phone },
    wardName: r.ward_name, bedLabel: r.bed_label, doctorName: r.doctor_name,
  }));
}

/**
 * Every admitted patient's medicines still running, with the last two days of doses: enough for the
 * ward's dose round to work out what is due now and what was missed.
 */
export async function listWardMeds(q: Queryable, now = new Date()): Promise<WardMeds[]> {
  const patients = await listInpatients(q);
  if (!patients.length) return [];
  const ids = patients.map((p) => p.admissionId);
  const meds = (await q.query<{ id: string; admission_id: string; med: MedOrder["med"]; started_at: string; started_by: string }>(
    `select m.id, m.admission_id, m.med, m.started_at, ${nameOf("m.started_by")} as started_by
       from ipd.med_order m where m.admission_id = any($1) and m.stopped_at is null order by m.started_at, m.id`, [ids],
  )).rows;
  const doses = (await q.query<{ id: string; med_order_id: string; status: DoseEntry["status"]; note: string; at: string; by_name: string }>(
    `select d.id, d.med_order_id, d.status, d.note, d.at, ${nameOf("d.by_user")} as by_name
       from ipd.med_dose d join ipd.med_order m on m.id = d.med_order_id
      where m.admission_id = any($1) and m.stopped_at is null and d.at > $2
      order by d.at desc, d.id desc`, [ids, new Date(now.getTime() - 2 * 86_400_000).toISOString()],
  )).rows;
  return patients.map((p) => ({
    ...p,
    meds: meds.filter((m) => m.admission_id === p.admissionId).map((m): MedOrder => ({
      id: m.id, med: m.med, startedAt: m.started_at, startedBy: m.started_by, stoppedAt: null, stoppedBy: null, stopReason: "",
      doses: doses.filter((d) => d.med_order_id === m.id).map((d) => ({ id: d.id, status: d.status, note: d.note, at: d.at, by: d.by_name })),
    })),
  }));
}

// ───────────────────────── Reading ─────────────────────────

interface AdmissionRow {
  id: string; admission_no: string; status: Admission["status"]; admitted_at: string; admitted_by: string; discharged_at: string | null; reason: string;
  attendant_name: string; attendant_relation: string; attendant_phone: string; summary: DischargeSummary | null; summary_version: number;
  summary_signed_at: string | null; signed_by_name: string | null; discharge_type: AdmissionSummary["dischargeType"]; discount: number; final_bill_no: string | null;
  p_id: string; uhid: string; p_name: string; sex: Admission["patient"]["sex"]; dob: string | null; phone: string; details_pending: boolean;
  emergency: boolean; mlc: boolean; mlc_no: string; police_station: string; brought_by: string;
  d_id: string; d_name: string; department: string; qualification: string; registration_no: string;
  bed_id: string; bed_label: string; ward_id: string; ward_name: string; ward_kind: BedStay["wardKind"];
}

const ADMISSION_SELECT = `
  select a.*, ${nameOf("a.created_by")} as admitted_by, ${nameOf("a.summary_signed_by")} as signed_by_name,
         p.id as p_id, p.uhid, p.name as p_name, p.sex, p.dob, p.phone, p.details_pending,
         d.id as d_id, d.name as d_name, d.department, d.qualification, d.registration_no,
         b.label as bed_label, w.id as ward_id, w.name as ward_name, w.kind as ward_kind
    from ipd.admission a
    join core.patient p on p.id = a.patient_id
    join core.practitioner d on d.id = a.practitioner_id
    join ipd.bed b on b.id = a.bed_id
    join ipd.ward w on w.id = b.ward_id`;

export async function getAdmission(q: Queryable, id: string, now = new Date()): Promise<Admission> {
  const a = (await q.query<AdmissionRow>(`${ADMISSION_SELECT} where a.id = $1`, [id])).rows[0];
  if (!a) throw new AppError(404, "admission_not_found", "Admission not found");
  const stays = (await q.query<StayRow>("select * from ipd.bed_stay where admission_id = $1 order by from_at", [id])).rows;
  const notes = (await q.query<{ id: string; kind: NoteKind; text: string; at: string; by_name: string }>(
    `select n.id, n.kind, n.text, n.at, ${nameOf("n.by_user")} as by_name from ipd.note n where n.admission_id = $1 order by n.at desc, n.id desc`, [id],
  )).rows.map((n): ChartNote => ({ id: n.id, kind: n.kind, text: n.text, at: n.at, by: n.by_name }));
  const vitals = (await q.query<{ id: string; vitals: Vitals; at: string; by_name: string }>(
    `select v.id, v.vitals, v.at, ${nameOf("v.by_user")} as by_name from ipd.vitals v where v.admission_id = $1 order by v.at desc, v.id desc`, [id],
  )).rows.map((v): VitalsEntry => ({ id: v.id, vitals: v.vitals, at: v.at, by: v.by_name }));
  const medRows = (await q.query<{ id: string; med: MedOrder["med"]; started_at: string; started_by: string; stopped_at: string | null; stopped_by: string | null; stop_reason: string }>(
    `select m.id, m.med, m.started_at, ${nameOf("m.started_by")} as started_by, m.stopped_at, ${nameOf("m.stopped_by")} as stopped_by, m.stop_reason
       from ipd.med_order m where m.admission_id = $1 order by m.started_at, m.id`, [id],
  )).rows;
  const doses = (await q.query<{ id: string; med_order_id: string; status: DoseEntry["status"]; note: string; at: string; by_name: string }>(
    `select d.id, d.med_order_id, d.status, d.note, d.at, ${nameOf("d.by_user")} as by_name
       from ipd.med_dose d join ipd.med_order m on m.id = d.med_order_id where m.admission_id = $1 order by d.at desc, d.id desc`, [id],
  )).rows;
  const meds = medRows.map((m): MedOrder => ({
    id: m.id, med: m.med, startedAt: m.started_at, startedBy: m.started_by, stoppedAt: m.stopped_at, stoppedBy: m.stopped_by, stopReason: m.stop_reason,
    doses: doses.filter((d) => d.med_order_id === m.id).map((d) => ({ id: d.id, status: d.status, note: d.note, at: d.at, by: d.by_name })),
  }));
  const charges = (await q.query<{ id: string; description: string; category: Charge["category"]; quantity: number; unit_price: number; amount: number; charged_at: string; by_name: string; cancelled_at: string | null; cancel_reason: string }>(
    `select c.*, ${nameOf("c.charged_by")} as by_name from ipd.charge c where c.admission_id = $1 order by c.charged_at, c.id`, [id],
  )).rows.map((c): Charge => ({
    id: c.id, description: c.description, category: c.category, quantity: c.quantity, unitPrice: c.unit_price, amount: c.amount,
    at: c.charged_at, by: c.by_name, cancelledAt: c.cancelled_at, cancelReason: c.cancel_reason,
  }));
  const payments = (await q.query<{ id: string; receipt_no: string; kind: IpdPaymentKind; amount: number; mode: IpdPayment["mode"]; received_at: string; by_name: string }>(
    `select p.*, ${nameOf("p.received_by")} as by_name from ipd.payment p where p.admission_id = $1 order by p.received_at, p.receipt_no`, [id],
  )).rows.map((p): IpdPayment => ({ id: p.id, receiptNo: p.receipt_no, kind: p.kind, amount: p.amount, mode: p.mode, at: p.received_at, by: p.by_name }));
  const facility = (await q.query<Admission["facility"]>("select name, address, phone, email, gstin from core.facility where id = 1")).rows[0]!;
  const counter = await counterLines(q, id);
  const amendments = (await q.query<{ version: number; amended_at: string; by_name: string; reason: string }>(
    `select s.version, s.amended_at, ${nameOf("s.amended_by")} as by_name, s.reason from ipd.summary_amendment s where s.admission_id = $1 order by s.version`, [id],
  )).rows.map((s): SummaryAmendment => ({ version: s.version, at: s.amended_at, by: s.by_name, reason: s.reason }));
  const end = a.discharged_at ? new Date(a.discharged_at) : now;
  return {
    id: a.id, admissionNo: a.admission_no, status: a.status, admittedAt: a.admitted_at, admittedBy: a.admitted_by, dischargedAt: a.discharged_at,
    patient: { id: a.p_id, uhid: a.uhid, name: a.p_name, sex: a.sex, dob: a.dob, phone: a.phone },
    doctor: { id: a.d_id, name: a.d_name, department: a.department, qualification: a.qualification, registrationNo: a.registration_no },
    reason: a.reason,
    attendant: { name: a.attendant_name, relation: a.attendant_relation, phone: a.attendant_phone },
    emergency: a.emergency,
    mlc: a.mlc ? { no: a.mlc_no, policeStation: a.police_station, broughtBy: a.brought_by } : null,
    detailsPending: a.details_pending,
    bed: a.status === "ADMITTED" ? { id: a.bed_id, label: a.bed_label, wardId: a.ward_id, wardName: a.ward_name, wardKind: a.ward_kind } : null,
    stays: stays.map((s) => ({
      wardName: s.ward_name, wardKind: s.ward_kind, bedLabel: s.bed_label, bedCharge: s.bed_charge, nursingCharge: s.nursing_charge, from: s.from_at, to: s.to_at, reason: s.reason,
    })),
    notes, vitals, meds, charges, payments,
    summary: a.summary, summaryVersion: a.summary_version, summarySignedAt: a.summary_signed_at, summarySignedBy: a.summary_signed_at ? a.signed_by_name : null,
    amendments,
    finalBillNo: a.final_bill_no,
    bill: computeBill(new Date(a.admitted_at), end, stays, charges, payments, a.discount, counter),
    facility,
  };
}

/** Who is in now, or who left recently (or matches a search). */
export async function listAdmissions(q: Queryable, opts: { status: "ADMITTED" | "DISCHARGED"; q?: string; now?: Date }): Promise<AdmissionSummary[]> {
  const term = (opts.q ?? "").trim().toLowerCase().slice(0, 60);
  const since = new Date((opts.now ?? new Date()).getTime() - 30 * 86_400_000).toISOString();
  const { rows } = await q.query<AdmissionRow>(
    `${ADMISSION_SELECT}
      where a.status = $1
        and ($2 = '' or lower(p.name) like '%' || $2 || '%' or lower(p.uhid) = $2 or lower(a.admission_no) = $2 or p.phone = $2)
        and ($1 = 'ADMITTED' or $2 <> '' or a.discharged_at >= $3::timestamptz)
      order by ${opts.status === "ADMITTED" ? "a.admitted_at" : "a.discharged_at desc"}
      limit 200`,
    [opts.status, term, since],
  );
  return rows.map((a) => ({
    id: a.id, admissionNo: a.admission_no, status: a.status, admittedAt: a.admitted_at, dischargedAt: a.discharged_at,
    patient: { id: a.p_id, uhid: a.uhid, name: a.p_name, sex: a.sex, dob: a.dob, phone: a.phone },
    doctorName: a.d_name, wardName: a.ward_name, bedLabel: a.bed_label, dischargeType: a.discharge_type, dischargeAdvised: !!a.summary_signed_at,
    emergency: a.emergency, mlc: a.mlc,
  }));
}

// ───────────────────────── Admission and beds ─────────────────────────

/** Locks the admission row and refuses changes once the patient has gone home. */
async function openAdmission(q: Queryable, id: string): Promise<{ bed_id: string; patient_id: string; summary_version: number; summary_signed_at: string | null; summary: DischargeSummary | null; discount: number; admitted_at: string }> {
  const a = (await q.query<{ status: string; bed_id: string; patient_id: string; summary_version: number; summary_signed_at: string | null; summary: DischargeSummary | null; discount: number; admitted_at: string }>(
    "select status, bed_id, patient_id, summary_version, summary_signed_at, summary, discount, admitted_at from ipd.admission where id = $1 for update", [id],
  )).rows[0];
  if (!a) throw new AppError(404, "admission_not_found", "Admission not found");
  if (a.status !== "ADMITTED") throw new AppError(409, "already_discharged", "This patient has been discharged; the record can no longer be changed");
  return a;
}

/** A bed that can take a patient now: in use, clean, and empty. */
async function freeBed(q: Queryable, bedId: string) {
  const b = (await q.query<{ id: string; label: string; active: boolean; needs_cleaning: boolean; ward_active: boolean; ward_name: string; ward_kind: BedStay["wardKind"]; bed_charge: number; nursing_charge: number }>(
    `select b.id, b.label, b.active, b.needs_cleaning, w.active as ward_active, w.name as ward_name, w.kind as ward_kind, w.bed_charge, w.nursing_charge
       from ipd.bed b join ipd.ward w on w.id = b.ward_id where b.id = $1 for update of b`, [bedId],
  )).rows[0];
  if (!b || !b.active || !b.ward_active) throw new AppError(422, "bed_not_found", "That bed isn't in use", { fields: { bedId: "Choose another bed" } });
  if (b.needs_cleaning) throw new AppError(409, "bed_cleaning", `Bed ${b.label} is waiting to be cleaned`, { fields: { bedId: "Being cleaned" } });
  if ((await q.query("select 1 from ipd.admission where bed_id = $1 and status = 'ADMITTED'", [bedId])).rows[0]) {
    throw new AppError(409, "bed_taken", `Bed ${b.label} already has a patient`, { fields: { bedId: "Already taken" } });
  }
  return b;
}

const bedTaken = (e: unknown): never => {
  if (isUniqueViolation(e, "admission_bed_uq")) throw new AppError(409, "bed_taken", "Someone else just put a patient in that bed. Choose another.", { fields: { bedId: "Just taken" } });
  if (isUniqueViolation(e, "admission_patient_uq")) throw new AppError(409, "already_admitted", "This patient is already admitted");
  throw e;
};

export async function admit(db: Db, actor: Actor, raw: unknown, now = new Date()): Promise<Admission> {
  const v = AdmitInput.parse(raw);
  try {
    return await once(db, v.idempotencyKey, (q) => admitIn(q, actor, { ...v, emergency: false, mlc: false, mlcNo: "", policeStation: "", broughtBy: "" }, now));
  } catch (e) {
    return bedTaken(e);
  }
}

/**
 * Casualty: registers the patient at the door if they are new (or unknown), and admits them straight
 * to a bed with no advance. Medico-legal details can be given now or later.
 */
export async function admitEmergency(db: Db, actor: Actor, raw: unknown, now = new Date()): Promise<Admission> {
  const v = EmergencyAdmitInput.parse(raw);
  try {
    return await once(db, v.idempotencyKey, async (q) => {
      const patientId = v.patientId ?? (await registerEmergencyPatient(q, actor, v.newPatient, now)).id;
      return admitIn(q, actor, { ...v, patientId, deposit: 0, paymentMode: "CASH", emergency: true }, now);
    });
  } catch (e) {
    return bedTaken(e);
  }
}

type AdmitFields = Omit<z.output<typeof AdmitInput>, "idempotencyKey"> & z.output<typeof MlcInput> & { emergency: boolean };

async function admitIn(q: Queryable, actor: Actor, v: AdmitFields, now: Date): Promise<Admission> {
  if (!(await q.query("select 1 from core.patient where id = $1 and deleted_at is null", [v.patientId])).rows[0]) {
    throw new AppError(422, "patient_not_found", "Patient not found", { fields: { patientId: "Choose the patient" } });
  }
  const already = (await q.query<{ admission_no: string; ward_name: string; label: string }>(
    `select a.admission_no, w.name as ward_name, b.label from ipd.admission a join ipd.bed b on b.id = a.bed_id join ipd.ward w on w.id = b.ward_id
      where a.patient_id = $1 and a.status = 'ADMITTED'`, [v.patientId],
  )).rows[0];
  if (already) throw new AppError(409, "already_admitted", `Already admitted (${already.admission_no}, ${already.ward_name} bed ${already.label})`);
  if (!(await q.query("select 1 from core.practitioner where id = $1 and active", [v.practitionerId])).rows[0]) {
    throw new AppError(422, "doctor_not_found", "Choose the admitting doctor", { fields: { practitionerId: "Choose the doctor" } });
  }
  const bed = await freeBed(q, v.bedId);
  const id = uuidv7();
  const admissionNo = await seq(q, "IP", now);
  await q.query(
    `insert into ipd.admission (id, admission_no, patient_id, practitioner_id, bed_id, admitted_at, reason, attendant_name, attendant_relation, attendant_phone,
                                emergency, mlc, mlc_no, police_station, brought_by, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
    [id, admissionNo, v.patientId, v.practitionerId, v.bedId, now.toISOString(), v.reason, v.attendantName, v.attendantRelation, v.attendantPhone,
      v.emergency, v.mlc, v.mlc ? v.mlcNo : "", v.mlc ? v.policeStation : "", v.broughtBy, actor.user],
  );
  await q.query(
    `insert into ipd.bed_stay (id, admission_id, bed_id, ward_name, ward_kind, bed_label, bed_charge, nursing_charge, gst_bp, from_at, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Admitted')`,
    [uuidv7(), id, v.bedId, bed.ward_name, bed.ward_kind, bed.label, bed.bed_charge, bed.nursing_charge, await stayGst(q, bed), now.toISOString()],
  );
  let receipt: string | undefined;
  if (v.deposit > 0) receipt = await pay(q, actor, id, "DEPOSIT", v.deposit, v.paymentMode, now);
  await audit(q, actor, v.emergency ? "ipd.admit_emergency" : "ipd.admit", "admission", id, {
    admissionNo, patient: v.patientId, doctor: v.practitionerId, bed: `${bed.ward_name} ${bed.label}`, deposit: v.deposit, receipt,
    ...(v.mlc ? { mlc: true, mlcNo: v.mlcNo } : {}),
  });
  return getAdmission(q, id, now);
}

/** Records or corrects the medico-legal details; the police number often arrives after admission or even discharge. */
export async function setMlc(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = MlcInput.parse(raw);
  return db.tx(async (q) => {
    const a = (await q.query<{ id: string }>("select id from ipd.admission where id = $1 for update", [id])).rows[0];
    if (!a) throw new AppError(404, "admission_not_found", "Admission not found");
    await q.query(
      `update ipd.admission set mlc = $2, mlc_no = $3, police_station = $4, brought_by = $5, updated_by = $6, updated_at = now(), row_version = row_version + 1 where id = $1`,
      [id, v.mlc, v.mlc ? v.mlcNo : "", v.mlc ? v.policeStation : "", v.broughtBy, actor.user],
    );
    await audit(q, actor, "ipd.mlc", "admission", id, v);
    return getAdmission(q, id, now);
  });
}

/** Completes the registration of a patient admitted through casualty in a hurry. */
export async function completeAdmittedPatient(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  return db.tx(async (q) => {
    const a = (await q.query<{ patient_id: string }>("select patient_id from ipd.admission where id = $1 for update", [id])).rows[0];
    if (!a) throw new AppError(404, "admission_not_found", "Admission not found");
    await completePatient(q, actor, a.patient_id, raw, now);
    return getAdmission(q, id, now);
  });
}

/** The GST rate (basis points) for a stay starting now in this bed, under the hospital's current rule. */
async function stayGst(q: Queryable, bed: { ward_kind: BedStay["wardKind"]; bed_charge: number }): Promise<number> {
  const f = (await q.query<{ room_gst_bp: number; room_gst_above: number }>("select room_gst_bp, room_gst_above from core.facility where id = 1")).rows[0];
  return f ? roomGstBp(bed.ward_kind, Number(bed.bed_charge), { bp: f.room_gst_bp, above: Number(f.room_gst_above) }) : 0;
}

async function pay(q: Queryable, actor: Actor, admissionId: string, kind: IpdPaymentKind, amount: number, mode: string, now: Date): Promise<string> {
  const receiptNo = await seq(q, "IPR", now);
  await q.query(
    "insert into ipd.payment (id, receipt_no, admission_id, kind, amount, mode, received_at, received_by) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [uuidv7(), receiptNo, admissionId, kind, amount, mode, now.toISOString(), actor.user],
  );
  return receiptNo;
}

export async function transfer(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = TransferInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const a = await openAdmission(q, id);
      if (a.bed_id === v.bedId) throw new AppError(422, "same_bed", "The patient is already in this bed", { fields: { bedId: "Same bed" } });
      const bed = await freeBed(q, v.bedId);
      await q.query("update ipd.bed_stay set to_at = $2 where admission_id = $1 and to_at is null", [id, now.toISOString()]);
      await q.query(
        `insert into ipd.bed_stay (id, admission_id, bed_id, ward_name, ward_kind, bed_label, bed_charge, nursing_charge, gst_bp, from_at, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuidv7(), id, v.bedId, bed.ward_name, bed.ward_kind, bed.label, bed.bed_charge, bed.nursing_charge, await stayGst(q, bed), now.toISOString(), v.reason],
      );
      await q.query("update ipd.admission set bed_id = $2, updated_by = $3, updated_at = now(), row_version = row_version + 1 where id = $1", [id, v.bedId, actor.user]);
      await q.query("update ipd.bed set needs_cleaning = true where id = $1", [a.bed_id]);
      await audit(q, actor, "ipd.transfer", "admission", id, { from: a.bed_id, to: v.bedId, bed: `${bed.ward_name} ${bed.label}`, reason: v.reason });
      return getAdmission(q, id, now);
    });
  } catch (e) {
    return bedTaken(e);
  }
}

// ───────────────────────── Chart ─────────────────────────

export async function addNote(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = NoteInput.parse(raw);
  return db.tx(async (q) => {
    await openAdmission(q, id);
    const nid = uuidv7();
    await q.query("insert into ipd.note (id, admission_id, kind, text, at, by_user) values ($1,$2,$3,$4,$5,$6)", [nid, id, v.kind, v.text, now.toISOString(), actor.user]);
    await audit(q, actor, "ipd.note", "admission", id, { note: nid, kind: v.kind });
    return getAdmission(q, id, now);
  });
}

export const noteKindOf = (raw: unknown): NoteKind | undefined => NoteInput.shape.kind.safeParse((raw as { kind?: unknown })?.kind).data;

export async function addVitals(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = VitalsInput.parse(raw);
  const vitals = Object.fromEntries(VITAL_KEYS.map((k) => [k, v[k] ?? null])) as Vitals;
  if (VITAL_KEYS.every((k) => vitals[k] == null)) throw new AppError(422, "vitals_empty", "Enter at least one reading");
  return db.tx(async (q) => {
    await openAdmission(q, id);
    await q.query("insert into ipd.vitals (id, admission_id, vitals, at, by_user) values ($1,$2,$3::jsonb,$4,$5)", [uuidv7(), id, JSON.stringify(vitals), now.toISOString(), actor.user]);
    return getAdmission(q, id, now);
  });
}

export async function addMed(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = MedOrderInput.parse(raw);
  const med = { ...v, durationDays: v.durationDays ?? null };
  return db.tx(async (q) => {
    await openAdmission(q, id);
    const mid = uuidv7();
    await q.query("insert into ipd.med_order (id, admission_id, med, started_at, started_by) values ($1,$2,$3::jsonb,$4,$5)", [mid, id, JSON.stringify(med), now.toISOString(), actor.user]);
    await audit(q, actor, "ipd.med.start", "admission", id, { med: mid, drug: v.drug, dose: v.dose, frequency: v.frequency, route: v.route });
    return getAdmission(q, id, now);
  });
}

async function medAdmission(q: Queryable, medId: string) {
  const m = (await q.query<{ admission_id: string; stopped_at: string | null; drug: string }>(
    "select admission_id, stopped_at, med->>'drug' as drug from ipd.med_order where id = $1", [medId],
  )).rows[0];
  if (!m) throw new AppError(404, "med_not_found", "Medicine not found on the chart");
  await openAdmission(q, m.admission_id);
  return m;
}

export async function stopMed(db: Db, actor: Actor, medId: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = StopMedInput.parse(raw ?? {});
  return db.tx(async (q) => {
    const m = await medAdmission(q, medId);
    if (m.stopped_at) throw new AppError(409, "med_stopped", `${m.drug} has already been stopped`);
    await q.query("update ipd.med_order set stopped_at = $2, stopped_by = $3, stop_reason = $4 where id = $1", [medId, now.toISOString(), actor.user, v.reason]);
    await audit(q, actor, "ipd.med.stop", "admission", m.admission_id, { med: medId, drug: m.drug, reason: v.reason });
    return getAdmission(q, m.admission_id, now);
  });
}

export async function recordDose(db: Db, actor: Actor, medId: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = DoseInput.parse(raw ?? {});
  return db.tx(async (q) => {
    const m = await medAdmission(q, medId);
    if (m.stopped_at) throw new AppError(409, "med_stopped", `${m.drug} was stopped; it can't be given`);
    await q.query("insert into ipd.med_dose (id, med_order_id, status, note, at, by_user) values ($1,$2,$3,$4,$5,$6)", [uuidv7(), medId, v.status, v.note, now.toISOString(), actor.user]);
    await audit(q, actor, "ipd.dose", "admission", m.admission_id, { med: medId, drug: m.drug, status: v.status, note: v.note });
    return getAdmission(q, m.admission_id, now);
  });
}

// ───────────────────────── Charges and deposits ─────────────────────────

export async function addCharge(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = ChargeInput.parse(raw);
  return db.tx(async (q) => {
    await openAdmission(q, id);
    if (v.serviceId && !(await q.query("select 1 from ipd.service where id = $1", [v.serviceId])).rows[0]) {
      throw new AppError(422, "service_not_found", "That service no longer exists", { fields: { serviceId: "Choose again" } });
    }
    const cid = uuidv7();
    await q.query(
      `insert into ipd.charge (id, admission_id, service_id, description, category, quantity, unit_price, amount, charged_at, charged_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cid, id, v.serviceId ?? null, v.description, v.category, v.quantity, v.unitPrice, v.quantity * v.unitPrice, now.toISOString(), actor.user],
    );
    await audit(q, actor, "ipd.charge", "admission", id, { charge: cid, description: v.description, amount: v.quantity * v.unitPrice });
    return getAdmission(q, id, now);
  });
}

export async function cancelCharge(db: Db, actor: Actor, chargeId: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = CancelChargeInput.parse(raw);
  return db.tx(async (q) => {
    const c = (await q.query<{ admission_id: string; cancelled_at: string | null; description: string; amount: number }>(
      "select admission_id, cancelled_at, description, amount from ipd.charge where id = $1", [chargeId],
    )).rows[0];
    if (!c) throw new AppError(404, "charge_not_found", "Charge not found");
    await openAdmission(q, c.admission_id);
    if (c.cancelled_at) throw new AppError(409, "charge_cancelled", "This charge has already been removed");
    await q.query("update ipd.charge set cancelled_at = $2, cancelled_by = $3, cancel_reason = $4 where id = $1", [chargeId, now.toISOString(), actor.user, v.reason]);
    await audit(q, actor, "ipd.charge.cancel", "admission", c.admission_id, { charge: chargeId, description: c.description, amount: c.amount, reason: v.reason });
    return getAdmission(q, c.admission_id, now);
  });
}

export async function addDeposit(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = DepositInput.parse(raw);
  return once(db, v.idempotencyKey, async (q) => {
    await openAdmission(q, id);
    const receipt = await pay(q, actor, id, "DEPOSIT", v.amount, v.paymentMode, now);
    await audit(q, actor, "ipd.deposit", "admission", id, { receipt, amount: v.amount, mode: v.paymentMode });
    return getAdmission(q, id, now);
  });
}

// ───────────────────────── Discharge ─────────────────────────

/** Saves the doctor's discharge summary. Changing a signed summary takes the signature off until it is signed again. */
export async function saveSummary(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = SummaryInput.parse(raw);
  return db.tx(async (q) => {
    const a = await openAdmission(q, id);
    if (v.summaryVersion !== a.summary_version) {
      throw new AppError(409, "changed_elsewhere", "Someone else changed this summary. Reload to see their changes.");
    }
    const { summaryVersion: _, ...rest } = v;
    const summary: DischargeSummary = { ...rest, followUpDate: v.followUpDate ?? null, medications: v.medications.map((m) => ({ ...m, durationDays: m.durationDays ?? null })) };
    await q.query(
      `update ipd.admission set summary = $2::jsonb, summary_version = summary_version + 1, summary_signed_at = null, summary_signed_by = null,
              updated_by = $3, updated_at = now(), row_version = row_version + 1 where id = $1`,
      [id, JSON.stringify(summary), actor.user],
    );
    if (a.summary_signed_at) await audit(q, actor, "ipd.summary.unsign", "admission", id, { reason: "edited after signing" });
    return getAdmission(q, id, now);
  });
}

/** The doctor signs the summary: discharge is advised, and the desk can settle the bill. */
export async function signSummary(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const version = (raw as { summaryVersion?: unknown })?.summaryVersion;
  return db.tx(async (q) => {
    const a = await openAdmission(q, id);
    if (version !== a.summary_version) throw new AppError(409, "changed_elsewhere", "The summary changed since you opened it. Reload and check it before signing.");
    if (!a.summary) throw new AppError(422, "summary_empty", "Write the discharge summary first");
    const missing: Record<string, string> = {};
    if (!a.summary.diagnoses.length) missing.diagnoses = "Add the final diagnosis";
    if (a.summary.dischargeType !== "DEATH" && !a.summary.conditionAtDischarge) missing.conditionAtDischarge = "Describe the condition at discharge";
    if (Object.keys(missing).length) throw new AppError(422, "summary_incomplete", Object.values(missing)[0]!, { fields: missing });
    if (a.summary_signed_at) throw new AppError(409, "summary_signed", "The summary is already signed");
    await q.query("update ipd.admission set summary_signed_at = $2, summary_signed_by = $3, updated_by = $3, updated_at = now() where id = $1", [id, now.toISOString(), actor.user]);
    await audit(q, actor, "ipd.summary.sign", "admission", id, { version: a.summary_version, type: a.summary.dischargeType });
    return getAdmission(q, id, now);
  });
}

/**
 * Corrects a discharge summary after discharge (a wrong diagnosis code, a missed medicine). The
 * version it replaces is kept with the reason, and the doctor making the correction signs it.
 */
export async function amendSummary(db: Db, actor: Actor, id: string, raw: unknown, now = new Date()): Promise<Admission> {
  const v = AmendSummaryInput.parse(raw);
  return db.tx(async (q) => {
    const a = (await q.query<{ status: string; summary: DischargeSummary | null; summary_version: number }>(
      "select status, summary, summary_version from ipd.admission where id = $1 for update", [id],
    )).rows[0];
    if (!a) throw new AppError(404, "admission_not_found", "Admission not found");
    if (a.status !== "DISCHARGED" || !a.summary) {
      throw new AppError(409, "not_discharged", "Before discharge, edit the summary directly; amendments are for signed summaries after discharge");
    }
    if (v.summaryVersion !== a.summary_version) throw new AppError(409, "changed_elsewhere", "Someone else changed this summary. Reload to see their changes.");
    const { summaryVersion: _, reason, ...rest } = v;
    const summary: DischargeSummary = { ...rest, followUpDate: v.followUpDate ?? null, medications: v.medications.map((m) => ({ ...m, durationDays: m.durationDays ?? null })) };
    const missing: Record<string, string> = {};
    if (!summary.diagnoses.length) missing.diagnoses = "Add the final diagnosis";
    if (summary.dischargeType !== "DEATH" && !summary.conditionAtDischarge) missing.conditionAtDischarge = "Describe the condition at discharge";
    if (Object.keys(missing).length) throw new AppError(422, "summary_incomplete", Object.values(missing)[0]!, { fields: missing });
    await q.query(
      "insert into ipd.summary_amendment (id, admission_id, version, previous, reason, amended_at, amended_by) values ($1,$2,$3,$4::jsonb,$5,$6,$7)",
      [uuidv7(), id, a.summary_version + 1, JSON.stringify(a.summary), reason, now.toISOString(), actor.user],
    );
    await q.query(
      `update ipd.admission set summary = $2::jsonb, summary_version = summary_version + 1, summary_signed_at = $3, summary_signed_by = $4,
              discharge_type = $5, updated_by = $4, updated_at = now(), row_version = row_version + 1 where id = $1`,
      [id, JSON.stringify(summary), now.toISOString(), actor.user, summary.dischargeType],
    );
    await audit(q, actor, "ipd.summary.amend", "admission", id, { version: a.summary_version + 1, reason });
    return getAdmission(q, id, now);
  });
}

/**
 * Settles the final bill and discharges: the balance is collected (or the extra deposit refunded),
 * the bill is numbered, and the bed goes for cleaning.
 */
export async function settle(db: Db, actor: Actor, id: string, raw: unknown, now = new Date(), opts: { allowDiscount?: boolean } = {}): Promise<Admission> {
  const v = SettleInput.parse(raw);
  if (v.discount > 0 && !opts.allowDiscount) {
    throw new AppError(403, "discount_not_allowed", "You don't have permission to give discounts. Ask an administrator.");
  }
  return once(db, v.idempotencyKey, async (q) => {
    const a = await openAdmission(q, id);
    if (!a.summary_signed_at || !a.summary) {
      throw new AppError(409, "summary_not_signed", "The doctor hasn't signed the discharge summary yet");
    }
    const { bill } = await getAdmission(q, id, now);
    if (bill.subtotal !== v.expectedSubtotal) {
      throw new AppError(409, "bill_changed", "The bill changed while you were looking at it (a charge was added or the day turned). Check the new total.");
    }
    if (v.discount > bill.subtotal) throw new AppError(422, "discount_too_large", "Discount can't be more than the bill", { fields: { discount: "More than the bill" } });
    const tax = taxOf(roomTax(bill.taxLines, bill.subtotal, v.discount));
    const balance = bill.subtotal - v.discount + tax - bill.paid;
    let receipt: string | undefined;
    if (balance > 0) receipt = await pay(q, actor, id, "FINAL", balance, v.paymentMode, now);
    if (balance < 0) receipt = await pay(q, actor, id, "REFUND", -balance, v.paymentMode, now);
    const billNo = await seq(q, "IPB", now);
    await q.query("update ipd.bed_stay set to_at = $2 where admission_id = $1 and to_at is null", [id, now.toISOString()]);
    await q.query(
      `update ipd.admission set status = 'DISCHARGED', discharged_at = $2, discharge_type = $3, discount = $4, final_bill_no = $5,
              updated_by = $6, updated_at = now(), row_version = row_version + 1 where id = $1`,
      [id, now.toISOString(), a.summary.dischargeType, v.discount, billNo, actor.user],
    );
    await q.query("update ipd.bed set needs_cleaning = true where id = $1", [a.bed_id]);
    await audit(q, actor, "ipd.discharge", "admission", id, {
      billNo, subtotal: bill.subtotal, discount: v.discount, tax, paid: bill.paid, balance, receipt, mode: v.paymentMode, type: a.summary.dischargeType,
    });
    return getAdmission(q, id, now);
  });
}
