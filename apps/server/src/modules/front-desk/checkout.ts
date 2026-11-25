import { CancelBillInput, CheckoutInput, type InvoiceLine, type Receipt } from "@ojas/shared";
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
        cancelled: null,
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
    cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string; refund_mode: Receipt["paymentMode"] | null; refunded: number | null;
  }>(
    `select i.invoice_no, i.issued_at, i.subtotal, i.discount, i.total, a.id as appointment_id, a.token, a.slot_start,
            p.uhid, p.name as p_name, p.sex, p.phone, p.dob, p.dob_estimated, d.name as d_name, d.department,
            (select mode from core.payment where invoice_id = i.id and kind = 'PAYMENT' order by received_at limit 1) as mode,
            i.cancelled_at, coalesce((select u.display_name from core.app_user u where u.username = i.cancelled_by), i.cancelled_by) as cancelled_by, i.cancel_reason,
            rf.mode as refund_mode, rf.amount as refunded
       from core.invoice i
       join core.appointment a on a.id = i.appointment_id
       join core.patient p on p.id = i.patient_id
       join core.practitioner d on d.id = a.practitioner_id
       left join core.payment rf on rf.invoice_id = i.id and rf.kind = 'REFUND'
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
    cancelled: r.cancelled_at
      ? { at: r.cancelled_at, by: r.cancelled_by ?? "", reason: r.cancel_reason, refundMode: r.refund_mode ?? r.mode, refunded: r.refunded ?? 0 }
      : null,
  };
}

/**
 * Cancels a paid OPD bill before the doctor has seen the patient: the appointment is cancelled
 * (freeing the slot) and the whole amount is refunded as a separate payment, so the day's cash
 * still adds up. The bill itself is never changed or deleted.
 */
export async function cancelBill(db: Db, actor: Actor, invoiceId: string, raw: unknown, now = new Date()): Promise<{ receipt: Receipt; visitDate: string }> {
  const v = CancelBillInput.parse(raw);
  return db.tx(async (q) => {
    const inv = (await q.query<{ invoice_no: string; status: string; total: number; appointment_id: string | null; a_status: string | null; visit_date: string | null }>(
      `select i.invoice_no, i.status, i.total, i.appointment_id, a.status as a_status, to_char(a.visit_date, 'YYYY-MM-DD') as visit_date
         from core.invoice i left join core.appointment a on a.id = i.appointment_id where i.id = $1 for update of i`, [invoiceId],
    )).rows[0];
    if (!inv) throw new AppError(404, "invoice_not_found", "Bill not found");
    if (inv.status === "CANCELLED") throw new AppError(409, "already_cancelled", `${inv.invoice_no} is already cancelled`);
    if (inv.a_status === "IN_CONSULT" || inv.a_status === "DONE") {
      throw new AppError(409, "consult_started", "The doctor has already seen this patient, so the bill can't be cancelled here. Ask an administrator.");
    }
    await q.query(
      "update core.invoice set status = 'CANCELLED', cancelled_at = $2, cancelled_by = $3, cancel_reason = $4, updated_by = $3, updated_at = now() where id = $1",
      [invoiceId, now.toISOString(), actor.user, v.reason],
    );
    if (inv.total > 0) {
      await q.query(
        "insert into core.payment (id, invoice_id, kind, mode, amount, received_at, received_by) values ($1,$2,'REFUND',$3,$4,$5,$6)",
        [uuidv7(), invoiceId, v.refundMode, inv.total, now.toISOString(), actor.user],
      );
    }
    if (inv.appointment_id && inv.a_status !== "CANCELLED") {
      await q.query("update core.appointment set status = 'CANCELLED', updated_by = $2, updated_at = now() where id = $1", [inv.appointment_id, actor.user]);
    }
    await audit(q, actor, "billing.cancel", "invoice", invoiceId, { invoiceNo: inv.invoice_no, refunded: inv.total, mode: v.refundMode, reason: v.reason });
    return { receipt: await getReceipt(q, invoiceId), visitDate: inv.visit_date ?? localDate(now) };
  });
}
