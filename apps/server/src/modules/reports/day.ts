import type { CashSource, DayReport, DayReportRow, PaymentMode } from "@ojas/shared";
import type { Queryable } from "../../db/index.js";
import { atLocal } from "../../core/clock.js";

/** The local day as [start, end) instants. */
const dayBounds = (date: string): [string, string] => {
  const end = atLocal(date, "00:00");
  end.setDate(end.getDate() + 1);
  return [atLocal(date, "00:00").toISOString(), end.toISOString()];
};

/**
 * Every rupee the counters took and gave back on one day. Money is counted when it changed hands:
 * an OPD refund today for yesterday's bill is in today's report. Pharmacy and lab bills put on an
 * in-patient's bill are listed apart: that money is collected at discharge, under In-patients.
 */
export async function dayReport(q: Queryable, date: string): Promise<DayReport> {
  const [from, to] = dayBounds(date);
  // One row per money movement: source, mode, who, in or out.
  const moves = (await q.query<{ source: CashSource; mode: PaymentMode; who: string; received: string; refunded: string; n: number }>(
    `with m as (
       select 'OPD' as source, p.mode, p.received_by as who,
              case when p.kind = 'PAYMENT' then p.amount else 0 end as received,
              case when p.kind = 'REFUND' then p.amount else 0 end as refunded
         from core.payment p where p.received_at >= $1 and p.received_at < $2
       union all
       select 'PHARMACY', s.payment_mode, s.created_by, s.total, 0
         from pharmacy.sale s where s.issued_at >= $1 and s.issued_at < $2 and s.payment_mode <> 'IPD'
       union all
       select 'LAB', o.payment_mode, o.created_by, o.total, 0
         from lab.lab_order o where o.ordered_at >= $1 and o.ordered_at < $2 and o.payment_mode <> 'IPD'
       union all
       select 'IPD', p.mode, p.received_by,
              case when p.kind = 'REFUND' then 0 else p.amount end,
              case when p.kind = 'REFUND' then p.amount else 0 end
         from ipd.payment p where p.received_at >= $1 and p.received_at < $2
     )
     select source, mode, who, sum(received)::bigint as received, sum(refunded)::bigint as refunded, (count(*) filter (where received > 0))::int as n
       from m group by source, mode, who`,
    [from, to],
  )).rows;

  const rows = new Map<string, DayReportRow>();
  const users = new Map<string, DayReport["byUser"][number]>();
  for (const m of moves) {
    const received = Number(m.received), refunded = Number(m.refunded);
    const r = rows.get(`${m.source}:${m.mode}`) ?? { source: m.source, mode: m.mode, received: 0, refunded: 0, count: 0 };
    r.received += received; r.refunded += refunded; r.count += m.n;
    rows.set(`${m.source}:${m.mode}`, r);
    const u = users.get(`${m.who}:${m.mode}`) ?? { user: m.who, name: m.who, mode: m.mode, received: 0, refunded: 0 };
    u.received += received; u.refunded += refunded;
    users.set(`${m.who}:${m.mode}`, u);
  }
  const names = new Map((await q.query<{ username: string; display_name: string }>(
    "select username, display_name from core.app_user where username = any($1)", [[...new Set(moves.map((m) => m.who))]],
  )).rows.map((u) => [u.username, u.display_name]));
  for (const u of users.values()) u.name = names.get(u.user) ?? u.user;

  const onIp = (await q.query<{ source: "PHARMACY" | "LAB"; amount: string; n: number }>(
    `select 'PHARMACY' as source, coalesce(sum(total), 0)::bigint as amount, count(*)::int as n from pharmacy.sale
      where issued_at >= $1 and issued_at < $2 and payment_mode = 'IPD'
     union all
     select 'LAB', coalesce(sum(total), 0)::bigint, count(*)::int from lab.lab_order
      where ordered_at >= $1 and ordered_at < $2 and payment_mode = 'IPD'`,
    [from, to],
  )).rows.filter((r) => r.n > 0).map((r) => ({ source: r.source, amount: Number(r.amount), count: r.n }));

  const discounts = (await q.query<{ source: CashSource; amount: string; n: number }>(
    `select 'OPD' as source, coalesce(sum(discount), 0)::bigint as amount, count(*)::int as n from core.invoice where issued_at >= $1 and issued_at < $2 and discount > 0
     union all
     select 'PHARMACY', coalesce(sum(discount), 0)::bigint, count(*)::int from pharmacy.sale where issued_at >= $1 and issued_at < $2 and discount > 0
     union all
     select 'LAB', coalesce(sum(discount), 0)::bigint, count(*)::int from lab.lab_order where ordered_at >= $1 and ordered_at < $2 and discount > 0
     union all
     select 'IPD', coalesce(sum(discount), 0)::bigint, count(*)::int from ipd.admission where discharged_at >= $1 and discharged_at < $2 and discount > 0`,
    [from, to],
  )).rows.filter((r) => r.n > 0).map((r) => ({ source: r.source, amount: Number(r.amount), count: r.n }));

  const cancellations = (await q.query<{ invoice_no: string; patient: string; total: number; cancel_reason: string; by_name: string; cancelled_at: string }>(
    `select i.invoice_no, p.name as patient, i.total, i.cancel_reason, i.cancelled_at,
            coalesce((select u.display_name from core.app_user u where u.username = i.cancelled_by), i.cancelled_by) as by_name
       from core.invoice i join core.patient p on p.id = i.patient_id
      where i.cancelled_at >= $1 and i.cancelled_at < $2 order by i.cancelled_at`,
    [from, to],
  )).rows.map((c) => ({ billNo: c.invoice_no, patient: c.patient, amount: Number(c.total), reason: c.cancel_reason, by: c.by_name, at: c.cancelled_at }));

  const order: CashSource[] = ["OPD", "PHARMACY", "LAB", "IPD"];
  const modes: PaymentMode[] = ["CASH", "UPI", "CARD"];
  return {
    date,
    rows: [...rows.values()].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source) || modes.indexOf(a.mode) - modes.indexOf(b.mode)),
    byUser: [...users.values()].sort((a, b) => a.name.localeCompare(b.name) || modes.indexOf(a.mode) - modes.indexOf(b.mode)),
    onIpBills: onIp,
    discounts,
    cancellations,
  };
}
