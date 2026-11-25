import {
  FacilityInput, HolidayInput, LeaveInput, PractitionerInput,
  type Facility, type Holiday, type Leave, type Practitioner, type PublicFacility,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { localDate } from "../../core/clock.js";
import { getPractitioner } from "../front-desk/scheduling.js";

// ───────────────────────── Facility ─────────────────────────

export async function getFacility(q: Queryable): Promise<Facility> {
  const { rows } = await q.query<Facility>(
    `select name, address, phone, email, gstin, receipt_footer as "receiptFooter", drug_licence as "drugLicence", uhid_prefix as "uhidPrefix",
            (room_gst_bp / 100.0)::float8 as "roomGstPercent", room_gst_above as "roomGstAbove",
            setup_completed as "setupCompleted", exists(select 1 from core.patient) as "hasPatients"
       from core.facility where id = 1`,
  );
  if (!rows[0]) throw new AppError(500, "no_facility", "Facility record missing");
  return rows[0];
}

export async function publicFacility(q: Queryable): Promise<PublicFacility> {
  const f = await getFacility(q);
  return { name: f.name, address: f.address, phone: f.phone, setupCompleted: f.setupCompleted };
}

export async function updateFacility(db: Db, actor: Actor, raw: unknown): Promise<Facility> {
  const v = FacilityInput.parse(raw);
  return db.tx(async (q) => {
    const cur = await getFacility(q);
    if (v.uhidPrefix !== cur.uhidPrefix && cur.hasPatients) {
      throw new AppError(422, "validation_failed", "Patient ID prefix can't change after patients are registered", {
        fields: { uhidPrefix: "Locked: patients already have IDs with this prefix" },
      });
    }
    await q.query(
      `update core.facility set name = $1, address = $2, phone = $3, email = $4, gstin = $5, receipt_footer = $6, uhid_prefix = $7,
              drug_licence = $9, room_gst_bp = $10, room_gst_above = $11, updated_at = now(), updated_by = $8, row_version = row_version + 1 where id = 1`,
      [v.name, v.address, v.phone, v.email, v.gstin, v.receiptFooter, v.uhidPrefix, actor.user, v.drugLicence, Math.round(v.roomGstPercent * 100), v.roomGstAbove],
    );
    await audit(q, actor, "settings.facility", "facility", "1", { ...v });
    return getFacility(q);
  });
}

/** Ends the first-run wizard. Needs at least one active doctor, or the front desk would have nothing to book. */
export async function completeSetup(db: Db, actor: Actor): Promise<Facility> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ n: number }>("select count(*)::int as n from core.practitioner where active");
    if (!rows[0]?.n) throw new AppError(422, "no_doctors", "Add at least one doctor before finishing setup");
    await q.query("update core.facility set setup_completed = true, updated_at = now(), updated_by = $1 where id = 1", [actor.user]);
    await audit(q, actor, "settings.setup_completed", "facility", "1");
    return getFacility(q);
  });
}

// ───────────────────────── Doctors ─────────────────────────

async function writeSessions(q: Queryable, practitionerId: string, sessions: PractitionerInput["sessions"]) {
  await q.query("delete from core.practitioner_session where practitioner_id = $1", [practitionerId]);
  for (const s of sessions) {
    await q.query(
      "insert into core.practitioner_session (id, practitioner_id, weekday, start_time, end_time) values ($1,$2,$3,$4,$5)",
      [uuidv7(), practitionerId, s.weekday, s.start, s.end],
    );
  }
}

export async function createPractitioner(db: Db, actor: Actor, raw: unknown): Promise<Practitioner> {
  const v = PractitionerInput.parse(raw);
  return db.tx(async (q) => {
    const id = uuidv7();
    await q.query(
      `insert into core.practitioner (id, name, department, qualification, registration_no, phone, consultation_fee, slot_minutes, active, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, v.name, v.department, v.qualification, v.registrationNo, v.phone, v.consultationFee, v.slotMinutes, v.active, actor.user],
    );
    await writeSessions(q, id, v.sessions);
    await audit(q, actor, "settings.practitioner.create", "practitioner", id, { ...v });
    return getPractitioner(q, id, { includeInactive: true });
  });
}

/** Full update. Past appointments and bills keep the fee and times they were made with. */
export async function updatePractitioner(db: Db, actor: Actor, id: string, raw: unknown): Promise<Practitioner> {
  const v = PractitionerInput.parse(raw);
  return db.tx(async (q) => {
    const before = await getPractitioner(q, id, { includeInactive: true });
    await q.query(
      `update core.practitioner set name = $2, department = $3, qualification = $4, registration_no = $5, phone = $6,
              consultation_fee = $7, slot_minutes = $8, active = $9, updated_at = now(), updated_by = $10, row_version = row_version + 1
        where id = $1`,
      [id, v.name, v.department, v.qualification, v.registrationNo, v.phone, v.consultationFee, v.slotMinutes, v.active, actor.user],
    );
    await writeSessions(q, id, v.sessions);
    await audit(q, actor, "settings.practitioner.update", "practitioner", id, {
      before: { fee: before.consultationFee, slotMinutes: before.slotMinutes, active: before.active, sessions: before.sessions },
      after: { ...v },
    });
    return getPractitioner(q, id, { includeInactive: true });
  });
}

/** Future bookings that a new holiday or leave would clash with, so the desk can call those patients. */
async function bookedBetween(q: Queryable, from: string, to: string, practitionerId?: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from core.appointment
      where visit_date between $1::date and $2::date and status in ('BOOKED','CHECKED_IN')
        and ($3::uuid is null or practitioner_id = $3::uuid)`,
    [from, to, practitionerId ?? null],
  );
  return rows[0]?.n ?? 0;
}

// ───────────────────────── Holidays ─────────────────────────

/** Holidays from 30 days ago onwards (older ones stay in the database for history). */
export async function listHolidays(q: Queryable, today = localDate()): Promise<Holiday[]> {
  const { rows } = await q.query<Holiday>(
    "select date::text as date, name from core.holiday where date >= $1::date - 30 order by date",
    [today],
  );
  return rows;
}

export async function addHoliday(db: Db, actor: Actor, raw: unknown): Promise<{ holiday: Holiday; bookedPatients: number }> {
  const v = HolidayInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      await q.query("insert into core.holiday (date, name, created_by, updated_by) values ($1, $2, $3, $3)", [v.date, v.name, actor.user]);
      await audit(q, actor, "settings.holiday.add", "holiday", v.date, { name: v.name });
      return { holiday: { date: v.date, name: v.name }, bookedPatients: await bookedBetween(q, v.date, v.date) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "validation_failed", "That date is already a holiday", { fields: { date: "Already a holiday" } });
    throw e;
  }
}

export async function deleteHoliday(db: Db, actor: Actor, date: string): Promise<void> {
  await db.tx(async (q) => {
    const { rows } = await q.query<{ name: string }>("delete from core.holiday where date = $1::date returning name", [date]);
    if (!rows[0]) throw new AppError(404, "not_found", "Holiday not found");
    await audit(q, actor, "settings.holiday.delete", "holiday", date, { name: rows[0].name });
  });
}

// ───────────────────────── Doctor leave ─────────────────────────

export async function listLeaves(q: Queryable, today = localDate()): Promise<Leave[]> {
  const { rows } = await q.query<Leave>(
    `select l.id, l.practitioner_id as "practitionerId", p.name as "practitionerName", l.from_date::text as "fromDate",
            l.to_date::text as "toDate", l.reason
       from core.practitioner_leave l join core.practitioner p on p.id = l.practitioner_id
      where l.to_date >= $1::date - 30 order by l.from_date`,
    [today],
  );
  return rows;
}

export async function addLeave(db: Db, actor: Actor, raw: unknown): Promise<{ leave: Leave; bookedPatients: number }> {
  const v = LeaveInput.parse(raw);
  return db.tx(async (q) => {
    const doctor = await getPractitioner(q, v.practitionerId, { includeInactive: true });
    const overlap = await q.query(
      "select 1 from core.practitioner_leave where practitioner_id = $1 and from_date <= $3::date and to_date >= $2::date",
      [v.practitionerId, v.fromDate, v.toDate],
    );
    if (overlap.rows.length) {
      throw new AppError(409, "validation_failed", `${doctor.name} already has leave in those dates`, { fields: { fromDate: "Overlaps existing leave" } });
    }
    const id = uuidv7();
    await q.query(
      `insert into core.practitioner_leave (id, practitioner_id, from_date, to_date, reason, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6)`,
      [id, v.practitionerId, v.fromDate, v.toDate, v.reason, actor.user],
    );
    await audit(q, actor, "settings.leave.add", "practitioner_leave", id, { ...v });
    return {
      leave: { id, practitionerId: v.practitionerId, practitionerName: doctor.name, fromDate: v.fromDate, toDate: v.toDate, reason: v.reason ?? "" },
      bookedPatients: await bookedBetween(q, v.fromDate, v.toDate, v.practitionerId),
    };
  });
}

export async function deleteLeave(db: Db, actor: Actor, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, "not_found", "Leave not found");
  await db.tx(async (q) => {
    const { rows } = await q.query<{ practitioner_id: string }>("delete from core.practitioner_leave where id = $1 returning practitioner_id", [id]);
    if (!rows[0]) throw new AppError(404, "not_found", "Leave not found");
    await audit(q, actor, "settings.leave.delete", "practitioner_leave", id, { practitionerId: rows[0].practitioner_id });
  });
}
