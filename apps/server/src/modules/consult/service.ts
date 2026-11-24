/**
 * OPD consultation: the doctor's record of one visit, and the prescription printed from it.
 *
 *  - Vitals (nurse or doctor) and the doctor's notes are saved separately, each with its own
 *    version, so two screens editing the same visit never overwrite each other's work.
 *  - Signing locks the record, stores a snapshot and marks the visit done.
 *  - A correction re-opens it with a reason; signing again adds a new version. Signed versions are
 *    never changed, and every sign and re-open is in the audit trail.
 */
import {
  COMMON_LAB_TESTS, ConsultNotesInput, ReopenInput, SuggestionKind, VITAL_KEYS, VitalsInput,
  type AppointmentStatus, type ConsultView, type Diagnosis, type Encounter, type LabOrder, type Medication, type MedTiming,
  type PastVisit, type Suggestion, type Vitals,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { getPatient } from "../front-desk/patients.js";

// ───────────────────────── Reading ─────────────────────────

const VITAL_COLUMNS: Record<(typeof VITAL_KEYS)[number], string> = {
  heightCm: "height_cm", weightKg: "weight_kg", temperatureF: "temperature_f", pulse: "pulse", bpSystolic: "bp_systolic",
  bpDiastolic: "bp_diastolic", respRate: "resp_rate", spo2: "spo2", bloodSugar: "blood_sugar",
};

interface EncounterRow {
  id: string; appointment_id: string; status: Encounter["status"]; version: number; notes_version: number;
  height_cm: number | null; weight_kg: number | null; temperature_f: number | null; pulse: number | null; bp_systolic: number | null;
  bp_diastolic: number | null; resp_rate: number | null; spo2: number | null; blood_sugar: number | null;
  vitals_at: string | null; vitals_by: string | null; chief_complaint: string; history: string; examination: string; advice: string;
  follow_up_date: string | null; signed_at: string | null; signed_by: string | null; reopen_reason: string | null; updated_at: string;
}

const vitalsOf = (r: EncounterRow): Vitals =>
  Object.fromEntries(VITAL_KEYS.map((k) => [k, (r as unknown as Record<string, number | null>)[VITAL_COLUMNS[k]] ?? null])) as Vitals;

interface Children { diagnoses: Diagnosis[]; medications: Medication[]; labOrders: LabOrder[] }

/** Diagnoses, medicines and lab orders for several encounters at once, in line order. */
async function childrenOf(q: Queryable, ids: string[]): Promise<Map<string, Children>> {
  const out = new Map<string, Children>(ids.map((id) => [id, { diagnoses: [], medications: [], labOrders: [] }]));
  if (!ids.length) return out;
  const dx = await q.query<{ encounter_id: string; text: string; code: string }>(
    "select encounter_id, text, code from core.encounter_diagnosis where encounter_id = any($1::uuid[]) order by line_no", [ids]);
  for (const r of dx.rows) out.get(r.encounter_id)!.diagnoses.push({ text: r.text, code: r.code });
  const rx = await q.query<{ encounter_id: string; drug: string; dose: string; frequency: string; timing: MedTiming; duration_days: number | null; instructions: string }>(
    "select encounter_id, drug, dose, frequency, timing, duration_days, instructions from core.encounter_medication where encounter_id = any($1::uuid[]) order by line_no", [ids]);
  for (const r of rx.rows) {
    out.get(r.encounter_id)!.medications.push({ drug: r.drug, dose: r.dose, frequency: r.frequency, timing: r.timing, durationDays: r.duration_days, instructions: r.instructions });
  }
  const lab = await q.query<{ encounter_id: string; test: string; notes: string }>(
    "select encounter_id, test, notes from core.encounter_lab_order where encounter_id = any($1::uuid[]) order by line_no", [ids]);
  for (const r of lab.rows) out.get(r.encounter_id)!.labOrders.push({ test: r.test, notes: r.notes });
  return out;
}

function toEncounter(r: EncounterRow, c: Children): Encounter {
  return {
    id: r.id, status: r.status, version: r.version, notesVersion: r.notes_version, vitals: vitalsOf(r),
    vitalsRecordedAt: r.vitals_at, vitalsRecordedBy: r.vitals_by, chiefComplaint: r.chief_complaint, history: r.history,
    examination: r.examination, advice: r.advice, followUpDate: r.follow_up_date, ...c,
    signedAt: r.signed_at, signedBy: r.signed_by, reopenReason: r.reopen_reason,
  };
}

async function encounterFor(q: Queryable, appointmentId: string, forUpdate = false): Promise<Encounter | null> {
  const { rows } = await q.query<EncounterRow>(`select * from core.encounter where appointment_id = $1${forUpdate ? " for update" : ""}`, [appointmentId]);
  const r = rows[0];
  if (!r) return null;
  return toEncounter(r, (await childrenOf(q, [r.id])).get(r.id)!);
}

interface AppointmentRow {
  id: string; token: number; slot_start: string; status: AppointmentStatus; patient_id: string; practitioner_id: string;
  d_name: string; department: string; qualification: string; registration_no: string;
}

async function appointment(q: Queryable, id: string, forUpdate = false): Promise<AppointmentRow> {
  const { rows } = await q.query<AppointmentRow>(
    `select a.id, a.token, a.slot_start, a.status, a.patient_id, a.practitioner_id,
            d.name as d_name, d.department, d.qualification, d.registration_no
       from core.appointment a join core.practitioner d on d.id = a.practitioner_id
      where a.id = $1${forUpdate ? " for update of a" : ""}`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "appointment_not_found", "Appointment not found");
  return rows[0];
}

export async function getConsult(q: Queryable, appointmentId: string): Promise<ConsultView> {
  const a = await appointment(q, appointmentId);
  const f = await q.query<{ name: string; address: string; phone: string; email: string }>("select name, address, phone, email from core.facility where id = 1");
  return {
    appointmentId: a.id, token: a.token, slotStart: a.slot_start, appointmentStatus: a.status,
    patient: await getPatient(q, a.patient_id),
    practitioner: { id: a.practitioner_id, name: a.d_name, department: a.department, qualification: a.qualification, registrationNo: a.registration_no },
    encounter: await encounterFor(q, appointmentId),
    facility: f.rows[0] ?? { name: "", address: "", phone: "", email: "" },
  };
}

/** The patient's earlier signed visits, newest first (what the doctor glances at before writing). */
export async function patientHistory(q: Queryable, patientId: string, excludeAppointmentId?: string, limit = 20): Promise<PastVisit[]> {
  const { rows } = await q.query<EncounterRow & { visit_date: string; d_name: string }>(
    `select e.*, a.visit_date, d.name as d_name
       from core.encounter e
       join core.appointment a on a.id = e.appointment_id
       join core.practitioner d on d.id = e.practitioner_id
      where e.patient_id = $1 and e.version > 0 and ($2::uuid is null or e.appointment_id <> $2::uuid)
      order by a.slot_start desc
      limit $3`,
    [patientId, excludeAppointmentId ?? null, limit],
  );
  const kids = await childrenOf(q, rows.map((r) => r.id));
  return rows.map((r) => {
    const c = kids.get(r.id)!;
    return {
      appointmentId: r.appointment_id, date: r.visit_date, practitionerName: r.d_name, chiefComplaint: r.chief_complaint,
      vitals: vitalsOf(r), diagnoses: c.diagnoses, medications: c.medications, labOrders: c.labOrders, advice: r.advice, followUpDate: r.follow_up_date,
    };
  });
}

// ───────────────────────── Writing ─────────────────────────

const SIGNED = () => new AppError(409, "encounter_signed", "This consultation is signed. Choose \"Correct\" to change it.");

/** The open encounter for an appointment, created on first use. Locks it for the rest of the transaction. */
async function openEncounter(q: Queryable, actor: Actor, a: AppointmentRow): Promise<EncounterRow> {
  if (a.status === "CANCELLED") throw new AppError(422, "appointment_cancelled", "This appointment was cancelled");
  const id = uuidv7();
  const created = await q.query<{ id: string }>(
    `insert into core.encounter (id, appointment_id, patient_id, practitioner_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5) on conflict (appointment_id) do nothing returning id`,
    [id, a.id, a.patient_id, a.practitioner_id, actor.user],
  );
  if (created.rows[0]) await audit(q, actor, "encounter.open", "encounter", id, { appointmentId: a.id });
  const { rows } = await q.query<EncounterRow>("select * from core.encounter where appointment_id = $1 for update", [a.id]);
  return rows[0]!;
}

/** The doctor started writing: the patient is with the doctor now. */
async function markInConsult(q: Queryable, actor: Actor, a: AppointmentRow): Promise<boolean> {
  if (a.status !== "BOOKED" && a.status !== "CHECKED_IN") return false;
  await q.query("update core.appointment set status = 'IN_CONSULT', updated_at = now(), updated_by = $2, row_version = row_version + 1 where id = $1", [a.id, actor.user]);
  await audit(q, actor, "appointment.status", "appointment", a.id, { from: a.status, to: "IN_CONSULT" });
  return true;
}

export interface SaveResult { encounter: Encounter; queueChanged: boolean; visitDate: string }

const visitDateOf = async (q: Queryable, appointmentId: string) =>
  (await q.query<{ visit_date: string }>("select visit_date from core.appointment where id = $1", [appointmentId])).rows[0]!.visit_date;

/** Nurse at triage, or the doctor: replaces the recorded vitals (empty fields clear them). */
export async function saveVitals(db: Db, actor: Actor, appointmentId: string, raw: unknown): Promise<SaveResult> {
  const v = VitalsInput.parse(raw);
  return db.tx(async (q) => {
    const a = await appointment(q, appointmentId, true);
    const e = await openEncounter(q, actor, a);
    if (e.status === "SIGNED") throw SIGNED();
    const sets = VITAL_KEYS.map((k, i) => `${VITAL_COLUMNS[k]} = $${i + 2}`).join(", ");
    const anyValue = VITAL_KEYS.some((k) => v[k] != null);
    await q.query(
      `update core.encounter set ${sets}, vitals_at = $${VITAL_KEYS.length + 2}, vitals_by = $${VITAL_KEYS.length + 3},
              updated_at = now(), updated_by = $${VITAL_KEYS.length + 3}, row_version = row_version + 1
        where id = $1`,
      [e.id, ...VITAL_KEYS.map((k) => v[k] ?? null), anyValue ? new Date().toISOString() : null, actor.user],
    );
    return { encounter: (await encounterFor(q, appointmentId))!, queueChanged: false, visitDate: await visitDateOf(q, appointmentId) };
  });
}

/** The doctor's draft: complaint, findings, diagnoses, medicines, tests, advice. Saved as they type. */
export async function saveNotes(db: Db, actor: Actor, appointmentId: string, raw: unknown): Promise<SaveResult> {
  const n = ConsultNotesInput.parse(raw);
  return db.tx(async (q) => {
    const a = await appointment(q, appointmentId, true);
    const e = await openEncounter(q, actor, a);
    if (e.status === "SIGNED") throw SIGNED();
    if (n.notesVersion !== e.notes_version) {
      throw new AppError(409, "changed_elsewhere", "This consultation was changed on another screen. Reload it to see the latest before editing.");
    }
    await q.query(
      `update core.encounter set chief_complaint = $2, history = $3, examination = $4, advice = $5, follow_up_date = $6,
              notes_version = notes_version + 1, updated_at = now(), updated_by = $7, row_version = row_version + 1
        where id = $1`,
      [e.id, n.chiefComplaint, n.history, n.examination, n.advice, n.followUpDate ?? null, actor.user],
    );
    for (const t of ["encounter_diagnosis", "encounter_medication", "encounter_lab_order"]) {
      await q.query(`delete from core.${t} where encounter_id = $1`, [e.id]);
    }
    for (const [i, d] of n.diagnoses.entries()) {
      await q.query("insert into core.encounter_diagnosis (id, encounter_id, line_no, text, code) values ($1,$2,$3,$4,$5)", [uuidv7(), e.id, i + 1, d.text, d.code]);
    }
    for (const [i, m] of n.medications.entries()) {
      await q.query(
        `insert into core.encounter_medication (id, encounter_id, line_no, drug, dose, frequency, timing, duration_days, instructions)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), e.id, i + 1, m.drug, m.dose, m.frequency, m.timing, m.durationDays ?? null, m.instructions],
      );
    }
    for (const [i, l] of n.labOrders.entries()) {
      await q.query("insert into core.encounter_lab_order (id, encounter_id, line_no, test, notes) values ($1,$2,$3,$4,$5)", [uuidv7(), e.id, i + 1, l.test, l.notes]);
    }
    const queueChanged = await markInConsult(q, actor, a);
    return { encounter: (await encounterFor(q, appointmentId))!, queueChanged, visitDate: await visitDateOf(q, appointmentId) };
  });
}

/** Locks the record, keeps this version exactly as signed, and completes the visit. */
export async function sign(db: Db, actor: Actor, appointmentId: string): Promise<SaveResult> {
  return db.tx(async (q) => {
    const a = await appointment(q, appointmentId, true);
    const cur = await encounterFor(q, appointmentId, true);
    if (!cur) throw new AppError(422, "nothing_to_sign", "Write the consultation before signing");
    if (cur.status === "SIGNED") throw new AppError(409, "encounter_signed", "This consultation is already signed");
    if (!cur.chiefComplaint && !cur.diagnoses.length && !cur.medications.length && !cur.advice) {
      throw new AppError(422, "nothing_to_sign", "Add a complaint, diagnosis, medicine or advice before signing");
    }
    const version = cur.version + 1;
    const signedAt = new Date().toISOString();
    const { id, status, notesVersion, signedAt: _a, signedBy: _b, reopenReason, ...content } = cur;
    await q.query(
      "insert into core.encounter_version (encounter_id, version, content, signed_at, signed_by, reason) values ($1,$2,$3::jsonb,$4,$5,$6)",
      [id, version, JSON.stringify(content), signedAt, actor.user, reopenReason],
    );
    await q.query(
      `update core.encounter set status = 'SIGNED', version = $2, signed_at = $3, signed_by = $4, reopen_reason = null,
              updated_at = now(), updated_by = $4, row_version = row_version + 1
        where id = $1`,
      [id, version, signedAt, actor.user],
    );
    await audit(q, actor, "encounter.sign", "encounter", id, { appointmentId, version, ...(reopenReason ? { correction: reopenReason } : {}) });
    let queueChanged = false;
    if (a.status !== "DONE") {
      await q.query("update core.appointment set status = 'DONE', updated_at = now(), updated_by = $2, row_version = row_version + 1 where id = $1", [a.id, actor.user]);
      await audit(q, actor, "appointment.status", "appointment", a.id, { from: a.status, to: "DONE" });
      queueChanged = true;
    }
    return { encounter: (await encounterFor(q, appointmentId))!, queueChanged, visitDate: await visitDateOf(q, appointmentId) };
  });
}

/** Opens a signed record for correction. The signed version stays on file; the reason is kept with the next one. */
export async function reopen(db: Db, actor: Actor, appointmentId: string, raw: unknown): Promise<SaveResult> {
  const { reason } = ReopenInput.parse(raw);
  return db.tx(async (q) => {
    const cur = await encounterFor(q, appointmentId, true);
    if (!cur || cur.status !== "SIGNED") throw new AppError(409, "not_signed", "Only a signed consultation can be corrected");
    await q.query(
      `update core.encounter set status = 'DRAFT', reopen_reason = $2, updated_at = now(), updated_by = $3, row_version = row_version + 1 where id = $1`,
      [cur.id, reason, actor.user],
    );
    await audit(q, actor, "encounter.reopen", "encounter", cur.id, { appointmentId, version: cur.version, reason });
    return { encounter: (await encounterFor(q, appointmentId))!, queueChanged: false, visitDate: await visitDateOf(q, appointmentId) };
  });
}

/** Every signed version of a consultation, oldest first (for checking what was corrected). */
export async function versions(q: Queryable, appointmentId: string): Promise<{ version: number; signedAt: string; signedBy: string; reason: string | null; content: unknown }[]> {
  const { rows } = await q.query<{ version: number; signed_at: string; signed_by: string; reason: string | null; content: unknown }>(
    `select v.version, v.signed_at, v.signed_by, v.reason, v.content
       from core.encounter_version v join core.encounter e on e.id = v.encounter_id
      where e.appointment_id = $1 order by v.version`,
    [appointmentId],
  );
  return rows.map((r) => ({ version: r.version, signedAt: r.signed_at, signedBy: r.signed_by, reason: r.reason, content: r.content }));
}

// ───────────────────────── Autocomplete ─────────────────────────

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** What this clinic has written before, most used first; for drugs, the way it was last prescribed. */
export async function suggestions(q: Queryable, rawKind: unknown, raw: string, limit = 10): Promise<Suggestion[]> {
  const kind = SuggestionKind.parse(rawKind);
  const term = likeEscape(raw.trim().toLowerCase()).slice(0, 60);
  const match = (col: string) => `($1 = '' or lower(${col}) like $1 || '%' or lower(${col}) like '%' || ' ' || $1 || '%' or lower(${col}) like '%(' || $1 || '%')`;

  if (kind === "drug") {
    const { rows } = await q.query<{ drug: string; dose: string; frequency: string; timing: MedTiming; duration_days: number | null; instructions: string; uses: number }>(
      `select drug, dose, frequency, timing, duration_days, instructions, uses from (
         select m.drug, m.dose, m.frequency, m.timing, m.duration_days, m.instructions,
                count(*) over (partition by lower(m.drug))::int as uses,
                row_number() over (partition by lower(m.drug) order by e.updated_at desc, m.line_no) as rn
           from core.encounter_medication m join core.encounter e on e.id = m.encounter_id
          where ${match("m.drug")}
       ) t where rn = 1 order by uses desc, drug limit $2`,
      [term, limit],
    );
    return rows.map((r) => ({
      text: r.drug, uses: r.uses,
      med: { dose: r.dose, frequency: r.frequency, timing: r.timing, durationDays: r.duration_days, instructions: r.instructions },
    }));
  }
  if (kind === "diagnosis") {
    const { rows } = await q.query<{ text: string; code: string; uses: number }>(
      `select text, code, uses from (
         select d.text, d.code, count(*) over (partition by lower(d.text))::int as uses,
                row_number() over (partition by lower(d.text) order by e.updated_at desc) as rn
           from core.encounter_diagnosis d join core.encounter e on e.id = d.encounter_id
          where ${match("d.text")}
       ) t where rn = 1 order by uses desc, text limit $2`,
      [term, limit],
    );
    return rows.map((r) => ({ text: r.text, uses: r.uses, ...(r.code ? { code: r.code } : {}) }));
  }
  const { rows } = await q.query<{ text: string; uses: number }>(
    `select min(test) as text, count(*)::int as uses from core.encounter_lab_order l
      where ${match("l.test")} group by lower(test) order by uses desc, text limit $2`,
    [term, limit],
  );
  const seen = new Set(rows.map((r) => r.text.toLowerCase()));
  const plain = raw.trim().toLowerCase();
  const common = COMMON_LAB_TESTS.filter((t) => !seen.has(t.toLowerCase()) && (!plain || t.toLowerCase().split(/[\s(]+/).some((w) => w.startsWith(plain)) || t.toLowerCase().startsWith(plain)));
  return [...rows, ...common.map((t) => ({ text: t, uses: 0 }))].slice(0, limit);
}
