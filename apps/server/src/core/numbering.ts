import type { Queryable } from "../db/index.js";

/**
 * Gap-free counters. Must be called inside the same transaction that uses the number, so a
 * rolled-back bill never burns an invoice number (GST requires continuous series).
 */
export async function nextNumber(q: Queryable, key: string): Promise<number> {
  const { rows } = await q.query<{ value: number }>(
    `insert into core.number_series (key, next_value) values ($1, 2)
     on conflict (key) do update set next_value = core.number_series.next_value + 1
     returning next_value - 1 as value`,
    [key],
  );
  return rows[0]!.value;
}

/** Indian financial year label, April–March: 2026-11-20 → "26-27". */
export function financialYear(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y % 100).padStart(2, "0")}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export async function nextUhid(q: Queryable, prefix: string): Promise<string> {
  return `${prefix}${String(await nextNumber(q, "uhid")).padStart(6, "0")}`;
}

export async function nextInvoiceNo(q: Queryable, at: Date): Promise<string> {
  const fy = financialYear(at);
  return `INV/${fy}/${String(await nextNumber(q, `invoice:${fy}`)).padStart(6, "0")}`;
}

/** Token numbers restart at 1 for each doctor each day. */
export async function nextToken(q: Queryable, practitionerId: string, visitDate: string): Promise<number> {
  return nextNumber(q, `token:${practitionerId}:${visitDate}`);
}
