import { CheckoutInput, type InvoiceLine, type Receipt } from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { localDate } from "../../core/clock.js";
import { nextInvoiceNo, nextToken } from "../../core/numbering.js";
import { getPatient } from "./patients.js";
import { dayGrid, getPractitioner } from "./scheduling.js";

/**
 * Front-desk checkout: book the slot, raise the invoice and record the payment as one atomic unit.
 * Safe to retry with the same idempotencyKey (double click, network blip, client crash).
 */
export async function checkout(db: Db, actor: Actor, input: unknown, now = new Date(), opts: { allowDiscount?: boolean } = {}): Promise<Receipt> {
  const v = CheckoutInput.parse(input);
  if ((v.discount ?? 0) > 0 && !opts.allowDiscount) {
    throw new AppError(403, "discount_not_allowed", "You don't have permission to give discounts. Ask accounts or an administrator.");
  }

  const previous = await db.query<{ response: Receipt }>("select response from core.idempotency where key = $1", [v.idempotencyKey]);
  if (previous.rows[0]) return previous.rows[0].response;

  const slotStart = new Date(v.slotStart);
  const visitDate = localDate(slotStart);

  try {
    return await db.tx(async (q) => {
      const patient = await getPatient(q, v.patientId);
      const doctor = await getPractitioner(q, v.practitionerId);

      // Re-check the schedule inside the transaction: holidays, leave and session times may have
      // changed since the receptionist loaded the slot list.
      const grid = await dayGrid(q, doctor, visitDate);
      if (grid.closed) throw new AppError(422, "day_closed", grid.closed);
      if (!grid.starts.includes(slotStart.getTime())) {
        throw new AppError(422, "invalid_slot", "That time is outside the doctor's schedule. Pick a slot from the list.");
      }
      if (slotStart.getTime() + doctor.slotMinutes * 60_000 <= now.getTime()) {
        throw new AppError(422, "slot_in_past", "That slot has already passed. Pick the next free slot.");
      }

      const appointmentId = uuidv7();
      const token = await nextToken(q, doctor.id, visitDate);
      await q.query(
        `insert into core.appointment (id, patient_id, practitioner_id, slot_start, visit_date, token, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [appointmentId, patient.id, doctor.id, slotStart.toISOString(), visitDate, token, actor.user],
      );

      // Billing: tariff lookup is the doctor's fee for now; packages and tariffs plug in here later.
      const lines: InvoiceLine[] = [
        { description: `Consultation — ${doctor.name} (${doctor.department})`, quantity: 1, unitPrice: doctor.consultationFee, amount: doctor.consultationFee },
      ];
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      const discount = v.discount ?? 0;
      if (discount > subtotal) throw new AppError(422, "discount_too_large", "Discount cannot be more than the bill amount");
      const total = subtotal - discount;

      const invoiceId = uuidv7();
      const invoiceNo = await nextInvoiceNo(q, now);
      const issuedAt = now.toISOString();
      await q.query(
        `insert into core.invoice (id, invoice_no, patient_id, appointment_id, issued_at, subtotal, discount, total, status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'PAID',$9,$9)`,
        [invoiceId, invoiceNo, patient.id, appointmentId, issuedAt, subtotal, discount, total, actor.user],
      );
      for (const [i, l] of lines.entries()) {
        await q.query(
          `insert into core.invoice_line (id, invoice_id, line_no, description, quantity, unit_price, amount) values ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), invoiceId, i + 1, l.description, l.quantity, l.unitPrice, l.amount],
        );
      }
      await q.query(
        `insert into core.payment (id, invoice_id, mode, amount, received_at, received_by) values ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), invoiceId, v.paymentMode, total, issuedAt, actor.user],
      );

      await audit(q, actor, "frontdesk.checkout", "invoice", invoiceId, {
        invoiceNo, appointmentId, patient: patient.uhid, practitioner: doctor.id, slotStart: slotStart.toISOString(), token, total, discount, mode: v.paymentMode,
      });
      await q.query(`insert into core.outbox (id, topic, payload) values ($1, 'sms.appointment_confirmation', $2::jsonb)`, [
        uuidv7(),
        JSON.stringify({ phone: patient.phone, name: patient.name, doctor: doctor.name, slotStart: slotStart.toISOString(), token }),
      ]);

      const receipt: Receipt = {
        appointmentId, token, slotStart: slotStart.toISOString(), invoiceNo, invoiceId, issuedAt,
        patient: { uhid: patient.uhid, name: patient.name, sex: patient.sex, phone: patient.phone, dob: patient.dob, dobEstimated: patient.dobEstimated },
        practitioner: { name: doctor.name, department: doctor.department },
        lines, subtotal, discount, total, paymentMode: v.paymentMode,
        facility: await facility(q),
      };
      await q.query("insert into core.idempotency (key, response) values ($1, $2::jsonb)", [v.idempotencyKey, JSON.stringify(receipt)]);
      return receipt;
    });
  } catch (e) {
    if (isUniqueViolation(e, "appointment_slot_uq")) {
      throw new AppError(409, "slot_taken", "Someone just booked that slot. The next free slot has been selected.");
    }
    if (isUniqueViolation(e, "idempotency_pkey")) {
      const again = await db.query<{ response: Receipt }>("select response from core.idempotency where key = $1", [v.idempotencyKey]);
      if (again.rows[0]) return again.rows[0].response;
    }
    throw e;
  }
}

async function facility(q: Queryable): Promise<Receipt["facility"]> {
  const { rows } = await q.query<Receipt["facility"]>(
    `select name, address, phone, gstin, receipt_footer as "receiptFooter" from core.facility where id = 1`,
  );
  return rows[0] ?? { name: "Ojas", address: "", phone: "", gstin: "", receiptFooter: "" };
}

/** Reprint: rebuild the receipt from the stored, immutable invoice records. */
export async function getReceipt(db: Queryable, invoiceId: string): Promise<Receipt> {
  const { rows } = await db.query<{
    invoice_no: string; issued_at: string; subtotal: number; discount: number; total: number; appointment_id: string; token: number; slot_start: string;
    uhid: string; p_name: string; sex: Receipt["patient"]["sex"]; phone: string; dob: string | null; dob_estimated: boolean;
    d_name: string; department: string; mode: Receipt["paymentMode"];
  }>(
    `select i.invoice_no, i.issued_at, i.subtotal, i.discount, i.total, a.id as appointment_id, a.token, a.slot_start,
            p.uhid, p.name as p_name, p.sex, p.phone, p.dob, p.dob_estimated, d.name as d_name, d.department,
            (select mode from core.payment where invoice_id = i.id order by received_at limit 1) as mode
       from core.invoice i
       join core.appointment a on a.id = i.appointment_id
       join core.patient p on p.id = i.patient_id
       join core.practitioner d on d.id = a.practitioner_id
      where i.id = $1`,
    [invoiceId],
  );
  const r = rows[0];
  if (!r) throw new AppError(404, "invoice_not_found", "Bill not found");
  const lines = await db.query<{ description: string; quantity: number; unit_price: number; amount: number }>(
    "select description, quantity, unit_price, amount from core.invoice_line where invoice_id = $1 order by line_no",
    [invoiceId],
  );
  return {
    appointmentId: r.appointment_id, token: r.token, slotStart: r.slot_start, invoiceNo: r.invoice_no, invoiceId, issuedAt: r.issued_at,
    patient: { uhid: r.uhid, name: r.p_name, sex: r.sex, phone: r.phone, dob: r.dob, dobEstimated: r.dob_estimated },
    practitioner: { name: r.d_name, department: r.department },
    lines: lines.rows.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, amount: l.amount })),
    subtotal: r.subtotal, discount: r.discount, total: r.total, paymentMode: r.mode,
    facility: await facility(db),
  };
}
