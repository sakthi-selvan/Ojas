/**
 * Pharmacy transactions: goods received from suppliers, medicines sold (dispensed), the bill,
 * the Schedule H / H1 / X register, and today's prescriptions waiting at the counter.
 */
import {
  COUNTED_FORMS, PurchaseInput, SaleInput, dosesPerDay, expiryDate, expiryLabel, gstBreakup, itemLabel, lineAmount, needsPrescriber, purchaseLineCost,
  type DrugSchedule, type Item, type PendingPrescription, type PharmacyBill, type PharmacyBillLine, type PurchaseSummary, type RegisterEntry, type SaleSummary,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { chargeTo } from "../ipd/admissions.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { atLocal, localDate } from "../../core/clock.js";
import { financialYear, nextNumber } from "../../core/numbering.js";
import { getItem, listItems, nameKey } from "./catalog.js";

/** Local midnight at the start of `date` and of the day after `to`, as instants (the database may run in UTC). */
const dayRange = (from: string, to = from): [string, string] => {
  const end = atLocal(to, "00:00");
  end.setDate(end.getDate() + 1);
  return [atLocal(from, "00:00").toISOString(), end.toISOString()];
};

const series = async (q: Queryable, prefix: string, key: string, at: Date) => {
  const fy = financialYear(at);
  return `${prefix}/${fy}/${String(await nextNumber(q, `${key}:${fy}`)).padStart(6, "0")}`;
};

async function remembered<T>(q: Queryable, key: string): Promise<T | undefined> {
  return (await q.query<{ response: T }>("select response from core.idempotency where key = $1", [key])).rows[0]?.response;
}

// ───────────────────────── Purchases ─────────────────────────

/** Receives a supplier invoice into stock: one batch per line (or more stock on a batch already held at that price). */
export async function receivePurchase(db: Db, actor: Actor, raw: unknown, now = new Date()): Promise<PurchaseSummary> {
  const v = PurchaseInput.parse(raw);
  const prev = await remembered<PurchaseSummary>(db, v.idempotencyKey);
  if (prev) return prev;
  const today = localDate(now);
  try {
    return await db.tx(async (q) => {
      const sup = (await q.query<{ name: string }>("select name from pharmacy.supplier where id = $1", [v.supplierId])).rows[0];
      if (!sup) throw new AppError(422, "validation_failed", "Choose the supplier", { fields: { supplierId: "Choose the supplier" } });
      const id = uuidv7();
      const purchaseNo = await series(q, "GRN", "purchase", now);
      let taxable = 0;
      let tax = 0;
      const lineRows: unknown[][] = [];
      for (const [i, l] of v.lines.entries()) {
        const item = await getItem(q, l.itemId, today);
        const expiry = expiryDate(l.expiry);
        if (expiry < today) {
          throw new AppError(422, "validation_failed", `${item.name}: batch ${l.batchNo} has already expired`, { fields: { [`lines.${i}.expiry`]: "Already expired" } });
        }
        const units = (l.packs + l.freePacks) * item.packSize;
        const existing = (await q.query<{ id: string; expiry: string }>(
          "select id, expiry from pharmacy.batch where item_id = $1 and batch_no = $2 and mrp_per_pack = $3 for update",
          [item.id, l.batchNo, l.mrpPerPack],
        )).rows[0];
        let batchId: string;
        if (existing) {
          if (existing.expiry !== expiry) {
            throw new AppError(422, "validation_failed", `${item.name}: batch ${l.batchNo} is already in stock with expiry ${expiryLabel(existing.expiry)}`, {
              fields: { [`lines.${i}.expiry`]: `In stock as ${expiryLabel(existing.expiry)}` },
            });
          }
          batchId = existing.id;
          await q.query(
            "update pharmacy.batch set on_hand = on_hand + $2, rate_per_pack = $3, updated_at = now(), updated_by = $4, row_version = row_version + 1 where id = $1",
            [batchId, units, l.ratePerPack, actor.user],
          );
        } else {
          batchId = uuidv7();
          await q.query(
            `insert into pharmacy.batch (id, item_id, batch_no, expiry, mrp_per_pack, rate_per_pack, pack_size, gst_rate, on_hand, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
            [batchId, item.id, l.batchNo, expiry, l.mrpPerPack, l.ratePerPack, item.packSize, l.gstRate, units, actor.user],
          );
        }
        await q.query("insert into pharmacy.stock_move (id, batch_id, qty, kind, ref_id, actor) values ($1,$2,$3,'PURCHASE',$4,$5)", [uuidv7(), batchId, units, id, actor.user]);
        const cost = purchaseLineCost(l);
        taxable += cost.taxable;
        tax += cost.tax;
        lineRows.push([uuidv7(), id, i + 1, batchId, l.packs, l.freePacks, l.ratePerPack, l.mrpPerPack, l.gstRate, cost.taxable, cost.tax]);
      }
      await q.query(
        `insert into pharmacy.purchase (id, purchase_no, supplier_id, invoice_no, invoice_date, received_at, taxable, tax, total, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id, purchaseNo, v.supplierId, v.invoiceNo, v.invoiceDate, now.toISOString(), taxable, tax, taxable + tax, actor.user],
      );
      for (const r of lineRows) {
        await q.query(
          `insert into pharmacy.purchase_line (id, purchase_id, line_no, batch_id, packs, free_packs, rate_per_pack, mrp_per_pack, gst_rate, taxable, tax)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          r,
        );
      }
      await audit(q, actor, "pharmacy.purchase", "purchase", id, { purchaseNo, supplier: v.supplierId, invoiceNo: v.invoiceNo, lines: v.lines.length, total: taxable + tax });
      const summary: PurchaseSummary = {
        id, purchaseNo, supplierName: sup.name, invoiceNo: v.invoiceNo, invoiceDate: v.invoiceDate, receivedAt: now.toISOString(),
        lines: v.lines.length, taxable, tax, total: taxable + tax,
      };
      await q.query("insert into core.idempotency (key, response) values ($1, $2::jsonb)", [v.idempotencyKey, JSON.stringify(summary)]);
      return summary;
    });
  } catch (e) {
    if (isUniqueViolation(e, "purchase_supplier_id_invoice_no_key")) {
      throw new AppError(409, "invoice_already_entered", `Invoice ${v.invoiceNo} from this supplier has already been entered`, { fields: { invoiceNo: "Already entered" } });
    }
    throw e;
  }
}

export async function listPurchases(q: Queryable, limit = 50): Promise<PurchaseSummary[]> {
  const { rows } = await q.query<{ id: string; purchase_no: string; supplier_name: string; invoice_no: string; invoice_date: string; received_at: string; lines: number; taxable: number; tax: number; total: number }>(
    `select p.id, p.purchase_no, s.name as supplier_name, p.invoice_no, p.invoice_date, p.received_at, p.taxable, p.tax, p.total,
            (select count(*)::int from pharmacy.purchase_line l where l.purchase_id = p.id) as lines
       from pharmacy.purchase p join pharmacy.supplier s on s.id = p.supplier_id
      order by p.received_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id, purchaseNo: r.purchase_no, supplierName: r.supplier_name, invoiceNo: r.invoice_no, invoiceDate: r.invoice_date, receivedAt: r.received_at,
    lines: r.lines, taxable: r.taxable, tax: r.tax, total: r.total,
  }));
}

// ───────────────────────── Sales ─────────────────────────

interface Allocation { itemId: string; batchId: string; qty: number }

/**
 * Sells medicines: takes stock from the earliest-expiring batches (or the batch chosen), never
 * from expired stock, writes the bill and the stock ledger together. Safe to retry with the same key.
 */
export async function sell(db: Db, actor: Actor, raw: unknown, now = new Date(), opts: { allowDiscount?: boolean } = {}): Promise<PharmacyBill> {
  const v = SaleInput.parse(raw);
  if (v.discount > 0 && !opts.allowDiscount) {
    throw new AppError(403, "discount_not_allowed", "You don't have permission to give discounts. Ask an administrator.");
  }
  const prev = await remembered<PharmacyBill>(db, v.idempotencyKey);
  if (prev) return prev;
  const today = localDate(now);

  try {
    return await db.tx(async (q) => {
      if (v.patientId && !(await q.query("select 1 from core.patient where id = $1", [v.patientId])).rows[0]) {
        throw new AppError(422, "patient_not_found", "Patient not found");
      }
      if (v.appointmentId && !(await q.query("select 1 from core.appointment where id = $1", [v.appointmentId])).rows[0]) {
        throw new AppError(422, "appointment_not_found", "That prescription's visit was not found");
      }
      if (v.admissionId && !v.patientId) throw new AppError(422, "patient_required", "Choose the in-patient to charge");
      const ip = v.admissionId ? await chargeTo(q, v.admissionId, v.patientId) : null;
      const mode = ip ? "IPD" : v.paymentMode;

      const items = new Map<string, Item>();
      const allocations: Allocation[] = [];
      for (const [i, l] of v.lines.entries()) {
        const item = items.get(l.itemId) ?? (await getItem(q, l.itemId, today));
        items.set(item.id, item);
        if (!item.active) throw new AppError(422, "item_inactive", `${item.name} is no longer sold`);
        if (needsPrescriber(item.schedule) && !v.prescriber.trim()) {
          throw new AppError(422, "validation_failed", `${item.name} is ${item.schedule === "X" ? "Schedule X" : `Schedule ${item.schedule}`}: enter the prescribing doctor`, {
            fields: { prescriber: "Needed for scheduled medicines" },
          });
        }
        const { rows: batches } = await q.query<{ id: string; on_hand: number; expiry: string }>(
          l.batchId
            ? "select id, on_hand, expiry from pharmacy.batch where id = $2 and item_id = $1 for update"
            : "select id, on_hand, expiry from pharmacy.batch where item_id = $1 and on_hand > 0 and expiry >= $2::date order by expiry, created_at for update",
          [item.id, l.batchId ?? today],
        );
        if (l.batchId && batches[0] && batches[0].expiry < today) {
          throw new AppError(422, "batch_expired", `${item.name}: that batch has expired and can't be sold`);
        }
        let need = l.qty;
        for (const b of batches) {
          if (need === 0) break;
          const take = Math.min(need, b.on_hand);
          if (take <= 0) continue;
          await q.query("update pharmacy.batch set on_hand = on_hand - $2, updated_at = now(), updated_by = $3, row_version = row_version + 1 where id = $1", [b.id, take, actor.user]);
          allocations.push({ itemId: item.id, batchId: b.id, qty: take });
          need -= take;
        }
        if (need > 0) {
          const have = l.qty - need;
          throw new AppError(422, "out_of_stock", `${itemLabel(item)}: only ${have} in stock${l.batchId ? " in that batch" : ""}`, {
            fields: { [`lines.${i}.qty`]: `Only ${have} in stock` },
          });
        }
      }

      // Bill lines: one per batch used, priced from that batch's MRP.
      const lines: (PharmacyBillLine & { itemId: string; batchId: string })[] = [];
      for (const a of allocations) {
        const item = items.get(a.itemId)!;
        const b = (await q.query<{ batch_no: string; expiry: string; mrp_per_pack: number; pack_size: number; gst_rate: number }>(
          "select batch_no, expiry, mrp_per_pack, pack_size, gst_rate from pharmacy.batch where id = $1", [a.batchId],
        )).rows[0]!;
        lines.push({
          itemId: item.id, batchId: a.batchId, itemName: itemLabel(item), hsn: item.hsn, schedule: item.schedule, batchNo: b.batch_no, expiry: b.expiry,
          qty: a.qty, packSize: b.pack_size, mrpPerPack: b.mrp_per_pack, gstRate: b.gst_rate, amount: lineAmount(b.mrp_per_pack, a.qty, b.pack_size),
        });
      }
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      if (v.discount > subtotal) throw new AppError(422, "discount_too_large", "Discount can't be more than the bill");

      const id = uuidv7();
      const billNo = await series(q, "PH", "pharmacy-bill", now);
      await q.query(
        `insert into pharmacy.sale (id, bill_no, issued_at, patient_id, customer_name, customer_phone, prescriber, appointment_id, subtotal, discount, total, payment_mode, admission_id, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [id, billNo, now.toISOString(), v.patientId ?? null, v.customerName, v.customerPhone, v.prescriber, v.appointmentId ?? null, subtotal, v.discount, subtotal - v.discount, mode, v.admissionId ?? null, actor.user],
      );
      for (const [i, l] of lines.entries()) {
        await q.query(
          `insert into pharmacy.sale_line (id, sale_id, line_no, item_id, batch_id, item_name, hsn, schedule, qty, mrp_per_pack, pack_size, gst_rate, amount)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [uuidv7(), id, i + 1, l.itemId, l.batchId, l.itemName, l.hsn, l.schedule, l.qty, l.mrpPerPack, l.packSize, l.gstRate, l.amount],
        );
        await q.query("insert into pharmacy.stock_move (id, batch_id, qty, kind, ref_id, actor) values ($1,$2,$3,'SALE',$4,$5)", [uuidv7(), l.batchId, -l.qty, id, actor.user]);
      }
      await audit(q, actor, "pharmacy.sale", "sale", id, {
        billNo, total: subtotal - v.discount, discount: v.discount, mode, admission: ip?.admissionNo, lines: lines.length,
        scheduled: lines.filter((l) => l.schedule !== "NONE").map((l) => l.itemName), prescriber: v.prescriber || undefined,
      });
      const bill = await getBill(q, id);
      await q.query("insert into core.idempotency (key, response) values ($1, $2::jsonb)", [v.idempotencyKey, JSON.stringify(bill)]);
      return bill;
    });
  } catch (e) {
    if (isUniqueViolation(e, "idempotency_pkey")) {
      const again = await remembered<PharmacyBill>(db, v.idempotencyKey);
      if (again) return again;
    }
    throw e;
  }
}

/** The bill, rebuilt from the stored sale (for printing and reprinting). */
export async function getBill(q: Queryable, id: string): Promise<PharmacyBill> {
  const { rows } = await q.query<{
    id: string; bill_no: string; issued_at: string; customer_name: string; customer_phone: string; uhid: string | null; prescriber: string;
    subtotal: number; discount: number; total: number; payment_mode: PharmacyBill["paymentMode"]; created_by: string; admission_id: string | null; admission_no: string | null;
  }>(
    `select s.*, p.uhid, a.admission_no from pharmacy.sale s left join core.patient p on p.id = s.patient_id
       left join ipd.admission a on a.id = s.admission_id where s.id = $1`,
    [id],
  );
  const s = rows[0];
  if (!s) throw new AppError(404, "bill_not_found", "Bill not found");
  const lines = (await q.query<{ item_name: string; hsn: string; schedule: DrugSchedule; batch_no: string; expiry: string; qty: number; pack_size: number; mrp_per_pack: number; gst_rate: number; amount: number }>(
    `select l.item_name, l.hsn, l.schedule, b.batch_no, b.expiry, l.qty, l.pack_size, l.mrp_per_pack, l.gst_rate, l.amount
       from pharmacy.sale_line l join pharmacy.batch b on b.id = l.batch_id where l.sale_id = $1 order by l.line_no`,
    [id],
  )).rows.map((l) => ({
    itemName: l.item_name, hsn: l.hsn, schedule: l.schedule, batchNo: l.batch_no, expiry: l.expiry, qty: l.qty, packSize: l.pack_size,
    mrpPerPack: l.mrp_per_pack, gstRate: l.gst_rate, amount: l.amount,
  }));
  const f = (await q.query<PharmacyBill["facility"]>(`select name, address, phone, gstin, drug_licence as "drugLicence" from core.facility where id = 1`)).rows[0]!;
  return {
    id: s.id, billNo: s.bill_no, issuedAt: s.issued_at, customerName: s.customer_name, customerPhone: s.customer_phone, uhid: s.uhid, prescriber: s.prescriber,
    lines, subtotal: s.subtotal, discount: s.discount, total: s.total, gst: gstBreakup(lines, s.discount), paymentMode: s.payment_mode, admissionId: s.admission_id, admissionNo: s.admission_no, soldBy: s.created_by, facility: f,
  };
}

export async function listSales(q: Queryable, date: string): Promise<SaleSummary[]> {
  const { rows } = await q.query<{ id: string; bill_no: string; issued_at: string; customer_name: string; total: number; payment_mode: SaleSummary["paymentMode"]; items: number }>(
    `select s.id, s.bill_no, s.issued_at, s.customer_name, s.total, s.payment_mode,
            (select count(*)::int from pharmacy.sale_line l where l.sale_id = s.id) as items
       from pharmacy.sale s
      where s.issued_at >= $1::timestamptz and s.issued_at < $2::timestamptz
      order by s.issued_at desc`,
    dayRange(date),
  );
  return rows.map((r) => ({ id: r.id, billNo: r.bill_no, issuedAt: r.issued_at, customerName: r.customer_name, total: r.total, paymentMode: r.payment_mode, items: r.items }));
}

// ───────────────────────── Schedule register ─────────────────────────

export async function register(q: Queryable, from: string, to: string, schedules: DrugSchedule[]): Promise<RegisterEntry[]> {
  const { rows } = await q.query<{ issued_at: string; bill_no: string; customer_name: string; customer_phone: string; prescriber: string; item_name: string; schedule: DrugSchedule; batch_no: string; qty: number }>(
    `select s.issued_at, s.bill_no, s.customer_name, s.customer_phone, s.prescriber, l.item_name, l.schedule, b.batch_no, l.qty
       from pharmacy.sale_line l
       join pharmacy.sale s on s.id = l.sale_id
       join pharmacy.batch b on b.id = l.batch_id
      where l.schedule = any($3::text[]) and s.issued_at >= $1::timestamptz and s.issued_at < $2::timestamptz
      order by s.issued_at, l.line_no`,
    [...dayRange(from, to), schedules],
  );
  return rows.map((r) => ({
    issuedAt: r.issued_at, billNo: r.bill_no, customerName: r.customer_name, customerPhone: r.customer_phone, prescriber: r.prescriber,
    itemName: r.item_name, schedule: r.schedule, batchNo: r.batch_no, qty: r.qty,
  }));
}

// ───────────────────────── Prescriptions at the counter ─────────────────────────

const FORM_WORDS = /^(tab|tabs|tablet|cap|caps|capsule|syp|syr|syrup|susp|inj|injection|oint|ointment|cream|gel|drops?|sachet|inh|inhaler)\.?\s+/i;

/** Finds the stocked medicine a prescription line most likely means ("Tab. Paracetamol 650" → Paracetamol 650 mg). */
async function matchItem(q: Queryable, drug: string, today: string): Promise<Item | null> {
  const name = nameKey(drug.replace(FORM_WORDS, ""));
  if (name.length < 2) return null;
  const words = name.split(" ");
  // Most specific first: the whole name, then fewer words.
  for (let n = words.length; n >= 1; n--) {
    const found = (await listItems(q, { q: words.slice(0, n).join(" "), today, limit: 20 })).filter((i) => i.active);
    if (!found.length) continue;
    // Prefer the strength the doctor wrote (e.g. "650"), then what's in stock.
    const strength = words.find((w) => /\d/.test(w));
    const score = (i: Item) => (strength && i.strength.toLowerCase().includes(strength) ? 2 : 0) + (i.onHand > 0 ? 1 : 0);
    return found.sort((a, b) => score(b) - score(a))[0]!;
  }
  return null;
}

/** Today's signed prescriptions with medicines that haven't been billed at the pharmacy yet. */
export async function pendingPrescriptions(q: Queryable, now = new Date()): Promise<PendingPrescription[]> {
  const today = localDate(now);
  const { rows } = await q.query<{ appointment_id: string; signed_at: string; patient_id: string; p_name: string; phone: string; uhid: string; d_name: string; encounter_id: string }>(
    `select e.appointment_id, e.signed_at, p.id as patient_id, p.name as p_name, p.phone, p.uhid, d.name as d_name, e.id as encounter_id
       from core.encounter e
       join core.appointment a on a.id = e.appointment_id
       join core.patient p on p.id = e.patient_id
       join core.practitioner d on d.id = e.practitioner_id
      where e.status = 'SIGNED' and a.visit_date = $1::date
        and exists (select 1 from core.encounter_medication m where m.encounter_id = e.id)
        and not exists (select 1 from pharmacy.sale s where s.appointment_id = e.appointment_id)
      order by e.signed_at`,
    [today],
  );
  const out: PendingPrescription[] = [];
  for (const r of rows) {
    const meds = (await q.query<{ drug: string; dose: string; frequency: string; duration_days: number | null }>(
      "select drug, dose, frequency, duration_days from core.encounter_medication where encounter_id = $1 order by line_no", [r.encounter_id],
    )).rows;
    const lines = [];
    for (const m of meds) {
      const item = await matchItem(q, m.drug, today);
      const perDay = dosesPerDay(m.frequency);
      const counted = item ? COUNTED_FORMS.includes(item.form) : false;
      // Tablets: doses a day × days. Otherwise (or when the doctor wrote "SOS"): one pack.
      const suggestedQty = counted && perDay && m.duration_days ? Math.ceil(perDay * m.duration_days) : item ? item.packSize : 1;
      lines.push({ drug: m.drug, dose: m.dose, frequency: m.frequency, durationDays: m.duration_days, item, suggestedQty });
    }
    out.push({
      appointmentId: r.appointment_id, signedAt: r.signed_at, patientId: r.patient_id, patientName: r.p_name, patientPhone: r.phone, uhid: r.uhid, prescriber: r.d_name, lines,
    });
  }
  return out;
}
