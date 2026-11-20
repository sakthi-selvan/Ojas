import type { Practitioner, Slot } from "@hs/shared";
import type { Queryable } from "../../db/index.js";
import { AppError } from "../../core/errors.js";
import { atLocal } from "../../core/clock.js";

interface PractitionerRow {
  id: string; name: string; department: string; consultation_fee: number; slot_minutes: number; day_start: string; day_end: string;
}

const toPractitioner = (r: PractitionerRow): Practitioner => ({
  id: r.id, name: r.name, department: r.department, consultationFee: r.consultation_fee,
  slotMinutes: r.slot_minutes, dayStart: r.day_start.slice(0, 5), dayEnd: r.day_end.slice(0, 5),
});

export async function listPractitioners(db: Queryable): Promise<Practitioner[]> {
  const { rows } = await db.query<PractitionerRow>(
    `select id, name, department, consultation_fee, slot_minutes, day_start::text, day_end::text
       from core.practitioner where active order by department, name`,
  );
  return rows.map(toPractitioner);
}

export async function getPractitioner(db: Queryable, id: string): Promise<Practitioner> {
  const { rows } = await db.query<PractitionerRow>(
    `select id, name, department, consultation_fee, slot_minutes, day_start::text, day_end::text
       from core.practitioner where id = $1 and active`,
    [id],
  );
  if (!rows[0]) throw new AppError(404, "practitioner_not_found", "Doctor not found or inactive");
  return toPractitioner(rows[0]);
}

/**
 * All slots of a doctor's day. A slot is unavailable when it is booked, or when it ended before now.
 * The slot in progress stays bookable, because walk-ins are seen "now".
 */
export async function slotsFor(db: Queryable, practitionerId: string, date: string, now = new Date()): Promise<Slot[]> {
  const p = await getPractitioner(db, practitionerId);
  const booked = await db.query<{ slot_start: string }>(
    `select slot_start from core.appointment where practitioner_id = $1 and visit_date = $2::date and status <> 'CANCELLED'`,
    [practitionerId, date],
  );
  const taken = new Set(booked.rows.map((r) => new Date(r.slot_start).getTime()));
  const stepMs = p.slotMinutes * 60_000;
  const end = atLocal(date, p.dayEnd).getTime();
  const slots: Slot[] = [];
  for (let t = atLocal(date, p.dayStart).getTime(); t + stepMs <= end; t += stepMs) {
    slots.push({ start: new Date(t).toISOString(), available: !taken.has(t) && t + stepMs > now.getTime() });
  }
  return slots;
}

/** True when `slotStart` lies exactly on the doctor's slot grid for that day. */
export function isOnGrid(p: Practitioner, date: string, slotStart: Date): boolean {
  const start = atLocal(date, p.dayStart).getTime();
  const end = atLocal(date, p.dayEnd).getTime();
  const step = p.slotMinutes * 60_000;
  const t = slotStart.getTime();
  return t >= start && t + step <= end && (t - start) % step === 0;
}
