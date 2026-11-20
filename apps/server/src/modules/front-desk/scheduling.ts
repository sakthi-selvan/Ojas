import { WEEKDAYS, type DaySlots, type Practitioner, type Session } from "@ojas/shared";
import type { Queryable } from "../../db/index.js";
import { AppError } from "../../core/errors.js";
import { atLocal } from "../../core/clock.js";

interface PractitionerRow {
  id: string; name: string; department: string; qualification: string; registration_no: string; phone: string;
  consultation_fee: number; slot_minutes: number; active: boolean;
}

const COLS = "id, name, department, qualification, registration_no, phone, consultation_fee, slot_minutes, active";

async function withSessions(q: Queryable, rows: PractitionerRow[]): Promise<Practitioner[]> {
  if (!rows.length) return [];
  const s = await q.query<{ practitioner_id: string; weekday: number; start_time: string; end_time: string }>(
    `select practitioner_id, weekday, start_time::text, end_time::text from core.practitioner_session
      where practitioner_id = any($1::uuid[]) order by weekday, start_time`,
    [rows.map((r) => r.id)],
  );
  const byDoc = new Map<string, Session[]>();
  for (const r of s.rows) {
    const list = byDoc.get(r.practitioner_id) ?? [];
    list.push({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
    byDoc.set(r.practitioner_id, list);
  }
  return rows.map((r) => ({
    id: r.id, name: r.name, department: r.department, qualification: r.qualification, registrationNo: r.registration_no, phone: r.phone,
    consultationFee: r.consultation_fee, slotMinutes: r.slot_minutes, active: r.active, sessions: byDoc.get(r.id) ?? [],
  }));
}

/** Doctors shown at the front desk (active only). Settings use `includeInactive`. */
export async function listPractitioners(db: Queryable, opts: { includeInactive?: boolean } = {}): Promise<Practitioner[]> {
  const { rows } = await db.query<PractitionerRow>(
    `select ${COLS} from core.practitioner ${opts.includeInactive ? "" : "where active"} order by active desc, department, name`,
  );
  return withSessions(db, rows);
}

export async function getPractitioner(db: Queryable, id: string, opts: { includeInactive?: boolean } = {}): Promise<Practitioner> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, "practitioner_not_found", "Doctor not found");
  const { rows } = await db.query<PractitionerRow>(`select ${COLS} from core.practitioner where id = $1 ${opts.includeInactive ? "" : "and active"}`, [id]);
  if (!rows[0]) throw new AppError(404, "practitioner_not_found", "Doctor not found or inactive");
  return (await withSessions(db, rows))[0]!;
}

const weekdayOf = (date: string) => atLocal(date, "12:00").getDay();

/**
 * The bookable grid for one doctor on one date (slot start times in ms), or why the day is closed.
 * Holiday beats leave beats "not a consulting day", which is the order the receptionist needs to hear.
 */
export async function dayGrid(q: Queryable, p: Practitioner, date: string): Promise<{ starts: number[]; closed?: string }> {
  const holiday = await q.query<{ name: string }>("select name from core.holiday where date = $1::date", [date]);
  if (holiday.rows[0]) return { starts: [], closed: `Clinic closed: ${holiday.rows[0].name}` };
  const leave = await q.query<{ reason: string; to_date: string }>(
    "select reason, to_date from core.practitioner_leave where practitioner_id = $1 and $2::date between from_date and to_date limit 1",
    [p.id, date],
  );
  if (leave.rows[0]) {
    const back = new Date(atLocal(leave.rows[0].to_date, "12:00").getTime() + 86_400_000);
    return {
      starts: [],
      closed: `${p.name} is on leave${leave.rows[0].reason ? ` (${leave.rows[0].reason})` : ""}, back ${back.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}`,
    };
  }
  const sessions = p.sessions.filter((s) => s.weekday === weekdayOf(date));
  if (!sessions.length) return { starts: [], closed: `${p.name} doesn't consult on ${WEEKDAYS[weekdayOf(date)]}s` };
  const step = p.slotMinutes * 60_000;
  const starts: number[] = [];
  for (const s of sessions) {
    const end = atLocal(date, s.end).getTime();
    for (let t = atLocal(date, s.start).getTime(); t + step <= end; t += step) starts.push(t);
  }
  return { starts };
}

/**
 * All slots of a doctor's day. A slot is unavailable when it is booked, or when it ended before now.
 * The slot in progress stays bookable, because walk-ins are seen "now".
 */
export async function slotsFor(db: Queryable, practitionerId: string, date: string, now = new Date()): Promise<DaySlots> {
  const p = await getPractitioner(db, practitionerId);
  const grid = await dayGrid(db, p, date);
  if (grid.closed) return { slots: [], closed: grid.closed };
  const booked = await db.query<{ slot_start: string }>(
    `select slot_start from core.appointment where practitioner_id = $1 and visit_date = $2::date and status <> 'CANCELLED'`,
    [practitionerId, date],
  );
  const taken = new Set(booked.rows.map((r) => new Date(r.slot_start).getTime()));
  const step = p.slotMinutes * 60_000;
  return { slots: grid.starts.map((t) => ({ start: new Date(t).toISOString(), available: !taken.has(t) && t + step > now.getTime() })) };
}
