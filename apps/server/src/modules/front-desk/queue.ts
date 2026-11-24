import { AppointmentStatus, type QueueItem } from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError } from "../../core/errors.js";

export async function queueFor(db: Queryable, date: string, practitionerId?: string): Promise<QueueItem[]> {
  const { rows } = await db.query<{
    id: string; token: number; slot_start: string; status: QueueItem["status"]; patient_name: string; uhid: string; practitioner_id: string; practitioner_name: string; has_vitals: boolean;
  }>(
    `select a.id, a.token, a.slot_start, a.status, p.name as patient_name, p.uhid, d.id as practitioner_id, d.name as practitioner_name,
            coalesce(e.vitals_at is not null, false) as has_vitals
       from core.appointment a
       join core.patient p on p.id = a.patient_id
       join core.practitioner d on d.id = a.practitioner_id
       left join core.encounter e on e.appointment_id = a.id
      where a.visit_date = $1::date and ($2::uuid is null or a.practitioner_id = $2::uuid) and a.status <> 'CANCELLED'
      order by a.slot_start, a.token`,
    [date, practitionerId ?? null],
  );
  return rows.map((r) => ({
    appointmentId: r.id, token: r.token, slotStart: r.slot_start, status: r.status, patientName: r.patient_name,
    uhid: r.uhid, practitionerId: r.practitioner_id, practitionerName: r.practitioner_name, vitalsRecorded: r.has_vitals,
  }));
}

/** Allowed status moves. A visit can only move forward, never jump back to an earlier status. */
const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  BOOKED: ["CHECKED_IN", "IN_CONSULT", "CANCELLED"],
  CHECKED_IN: ["IN_CONSULT", "CANCELLED"],
  IN_CONSULT: ["DONE"],
  DONE: [],
  CANCELLED: [],
};

export async function setStatus(db: Db, actor: Actor, appointmentId: string, raw: unknown): Promise<{ visitDate: string }> {
  const status = AppointmentStatus.parse(raw);
  return db.tx(async (q) => {
    const { rows } = await q.query<{ status: AppointmentStatus; visit_date: string }>(
      "select status, visit_date from core.appointment where id = $1 for update",
      [appointmentId],
    );
    const cur = rows[0];
    if (!cur) throw new AppError(404, "appointment_not_found", "Appointment not found");
    if (!NEXT[cur.status].includes(status)) {
      throw new AppError(422, "invalid_transition", `Cannot change a ${cur.status.toLowerCase().replace("_", " ")} visit to ${status.toLowerCase().replace("_", " ")}`);
    }
    await q.query(
      "update core.appointment set status = $2, updated_at = now(), updated_by = $3, row_version = row_version + 1 where id = $1",
      [appointmentId, status, actor.user],
    );
    await audit(q, actor, "appointment.status", "appointment", appointmentId, { from: cur.status, to: status });
    return { visitDate: cur.visit_date };
  });
}
