import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Printer, Trash2 } from "lucide-react";
import {
  CHARGE_CATEGORY_LABEL, ChargeCategory, formatINR,
  type Admission, type Charge, type PaymentMode,
} from "@ojas/shared";
import { api, ApiError, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Button, Card, Field, Select, cx } from "../../components/ui";
import { PaymentModeField, paiseOf } from "./common";
import { useAdmissionUpdate } from "./AdmissionView";
import type { IpdPrintJob } from "./printables";

const KIND_LABEL = { DEPOSIT: "Advance", FINAL: "Final payment", REFUND: "Refund" } as const;
const MODE_LABEL = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

/** The running bill: room by the night, the charges added, the advances taken, and what is still owed. */
export function BillTab({ admission: a, print }: { admission: Admission; print: (job: IpdPrintJob) => void }) {
  const { can } = useAuth();
  const open = a.status === "ADMITTED";
  const canBill = open && can("ipd.bill");
  const b = a.bill;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_26rem]">
      <div className="flex min-w-0 flex-col gap-4">
        {canBill && <AddCharge admission={a} />}
        <Card className="flex flex-col" aria-labelledby="bill-h">
          <h2 id="bill-h" className="border-b border-line p-4 font-semibold">{open ? `Bill so far · day ${b.days}` : `Final bill ${a.finalBillNo}`}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="p-2 pl-4 font-medium">Item</th><th className="p-2 text-right font-medium">Qty</th>
                <th className="p-2 text-right font-medium">Rate</th><th className="p-2 pr-4 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l, i) => (
                <tr key={i} className="border-b border-line/60">
                  <td className="p-2 pl-4">{l.description} <span className="text-xs text-ink-3">· {CHARGE_CATEGORY_LABEL[l.category]}</span></td>
                  <td className="p-2 text-right tabular-nums">{l.quantity}{l.category === "BED" || l.category === "NURSING" ? (l.quantity === 1 ? " day" : " days") : ""}</td>
                  <td className="p-2 text-right tabular-nums">{formatINR(l.unitPrice)}</td>
                  <td className="p-2 pr-4 text-right tabular-nums">{formatINR(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="text-right">
              <tr><td colSpan={3} className="p-2">Total</td><td className="p-2 pr-4 font-semibold tabular-nums">{formatINR(b.subtotal)}</td></tr>
              {b.discount > 0 && <tr><td colSpan={3} className="p-2">Discount</td><td className="p-2 pr-4 tabular-nums">− {formatINR(b.discount)}</td></tr>}
              {b.taxLines.map((t, i) => (
                <tr key={`tax-${i}`}>
                  <td colSpan={3} className="p-2">GST {t.ratePercent}% on {formatINR(t.taxable)}: {t.description} <span className="text-xs text-ink-3">(CGST {formatINR(t.cgst)} + SGST {formatINR(t.sgst)})</span></td>
                  <td className="p-2 pr-4 tabular-nums">{formatINR(t.amount)}</td>
                </tr>
              ))}
              {(b.discount > 0 || b.tax > 0) && <tr><td colSpan={3} className="p-2">Bill amount</td><td className="p-2 pr-4 font-semibold tabular-nums">{formatINR(b.total)}</td></tr>}
              <tr><td colSpan={3} className="p-2">Paid (advances{open ? "" : ", final payment"} less refunds)</td><td className="p-2 pr-4 tabular-nums">{formatINR(b.paid)}</td></tr>
              <tr className={cx("text-base font-bold", b.balance > 0 ? "text-warn" : "text-ok")}>
                <td colSpan={3} className="p-2">{b.balance > 0 ? "Balance due" : b.balance < 0 ? "Advance left over" : "Settled"}</td>
                <td className="p-2 pr-4 tabular-nums">{formatINR(Math.abs(b.balance))}</td>
              </tr>
            </tfoot>
          </table>
          {open && <p className="p-4 pt-1 text-xs text-ink-3">Room and nursing are charged for each night in a bed at midnight; a stay without a night counts as one day.</p>}
        </Card>
        <ChargeList admission={a} canCancel={canBill} />
      </div>
      <aside className="flex flex-col gap-4">
        {canBill && <AddDeposit admission={a} onPaid={(x) => { const p = x.payments.at(-1); if (p) print({ kind: "receipt", admission: x, payment: p }); }} />}
        <Card className="flex flex-col" aria-labelledby="pay-h">
          <h2 id="pay-h" className="border-b border-line p-4 font-semibold">Payments</h2>
          {a.payments.length === 0 && <p className="p-4 text-sm text-ink-3">No payments yet.</p>}
          <ul className="divide-y divide-line">
            {a.payments.map((p) => (
              <li key={p.id} className="flex items-center gap-2 p-3 text-sm">
                <span className="flex-1">
                  <span className="block font-semibold">{KIND_LABEL[p.kind]} · {formatINR(p.amount)} <span className="font-normal text-ink-3">{MODE_LABEL[p.mode]}</span></span>
                  <span className="block text-xs text-ink-3">{p.receiptNo} · {dateTimeLabel(p.at)} · {p.by}</span>
                </span>
                <Button variant="ghost" className="min-h-8 px-2" aria-label={`Print receipt ${p.receiptNo}`} onClick={() => print({ kind: "receipt", admission: a, payment: p })}><Printer aria-hidden className="size-4" /></Button>
              </li>
            ))}
          </ul>
        </Card>
      </aside>
    </div>
  );
}

function AddCharge({ admission: a }: { admission: Admission }) {
  const updated = useAdmissionUpdate();
  const services = useQuery({ queryKey: ["ipd-services"], queryFn: () => api.ipdServices() });
  const [serviceId, setServiceId] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ChargeCategory>("OTHER");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const pick = (id: string) => {
    setServiceId(id);
    const s = services.data?.find((x) => x.id === id);
    if (s) { setDescription(s.name); setCategory(s.category); setPrice(String(s.price / 100)); }
  };
  const add = useMutation({
    mutationFn: () => api.addCharge(a.id, { serviceId: serviceId || undefined, description, category, quantity: Number(qty) || 0, unitPrice: paiseOf(price) }),
    onSuccess: (x) => { updated(x); setServiceId(""); setDescription(""); setQty("1"); setPrice(""); setCategory("OTHER"); },
  });
  const errs = add.error instanceof ApiError ? add.error.fields : {};
  const amount = (Number(qty) || 0) * paiseOf(price);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby="charge-h">
      <h2 id="charge-h" className="font-semibold">Add a charge</h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[14rem_1fr_10rem]">
          <Select label="Service" value={serviceId} onChange={(e) => pick(e.target.value)}>
            <option value="">Type it in…</option>
            {services.data?.map((s) => <option key={s.id} value={s.id}>{s.name} · {formatINR(s.price)}</option>)}
          </Select>
          <Field label="Description" value={description} onChange={(e) => { setDescription(e.target.value); setServiceId(""); }} error={errs.description} placeholder="Dressing, ECG, oxygen 6 h…" />
          <Select label="Kind" value={category} onChange={(e) => setCategory(ChargeCategory.parse(e.target.value))}>
            {ChargeCategory.options.map((c) => <option key={c} value={c}>{CHARGE_CATEGORY_LABEL[c]}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Qty" className="w-20" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} error={errs.quantity} />
          <Field label="Rate ₹" className="w-32" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={errs.unitPrice} />
          <span className="pb-3 text-sm text-ink-2">= <b className="tabular-nums">{formatINR(amount)}</b></span>
          <Button type="submit" variant="primary" className="ml-auto" disabled={add.isPending || !description.trim() || amount <= 0}><Plus aria-hidden className="size-4" /> Add charge</Button>
        </div>
        {add.error && !Object.keys(errs).length && <Alert tone="danger">{add.error.message}</Alert>}
      </form>
    </Card>
  );
}

function ChargeList({ admission: a, canCancel }: { admission: Admission; canCancel: boolean }) {
  if (!a.charges.length) return null;
  return (
    <Card className="flex flex-col" aria-labelledby="charges-h">
      <h2 id="charges-h" className="border-b border-line p-4 font-semibold">Charges added</h2>
      <ul className="divide-y divide-line">
        {a.charges.map((c) => <ChargeRow key={c.id} charge={c} canCancel={canCancel} />)}
      </ul>
    </Card>
  );
}

function ChargeRow({ charge: c, canCancel }: { charge: Charge; canCancel: boolean }) {
  const updated = useAdmissionUpdate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useMutation({ mutationFn: () => api.cancelCharge(c.id, reason), onSuccess: updated });
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={cx("flex-1", c.cancelledAt && "text-ink-3 line-through")}>
          {c.description} · {c.quantity} × {formatINR(c.unitPrice)} = <b>{formatINR(c.amount)}</b>
          <span className="block text-xs text-ink-3 no-underline">{dateTimeLabel(c.at)} · {c.by}</span>
        </span>
        {c.cancelledAt ? <span className="text-xs text-ink-3">Removed: {c.cancelReason}</span>
          : canCancel && !open && <Button variant="ghost" className="min-h-8 px-2" aria-label={`Remove ${c.description}`} onClick={() => setOpen(true)}><Trash2 aria-hidden className="size-4" /></Button>}
      </div>
      {open && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <Field label="Why remove it?" className="min-w-56 flex-1" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" variant="danger" disabled={reason.trim().length < 3 || cancel.isPending}>Remove</Button>
          <Button onClick={() => setOpen(false)}>Keep</Button>
          {cancel.error && <div className="w-full"><Alert tone="danger">{cancel.error.message}</Alert></div>}
        </form>
      )}
    </li>
  );
}

function AddDeposit({ admission: a, onPaid }: { admission: Admission; onPaid: (a: Admission) => void }) {
  const updated = useAdmissionUpdate();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<PaymentMode>("CASH");
  const key = useRef(crypto.randomUUID());
  const pay = useMutation({
    mutationFn: () => api.addDeposit(a.id, { amount: paiseOf(text), paymentMode: mode, idempotencyKey: key.current }),
    onSuccess: (x) => { updated(x); setText(""); key.current = crypto.randomUUID(); onPaid(x); },
    onError: (e) => { if (e instanceof ApiError && e.status < 500) key.current = crypto.randomUUID(); },
  });
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby="dep-h">
      <h2 id="dep-h" className="font-semibold">Take an advance</h2>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); pay.mutate(); }}>
        <Field label="Amount ₹" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)}
          hint={a.bill.balance > 0 ? `${formatINR(a.bill.balance)} is due so far` : undefined} />
        <PaymentModeField name="dep-mode" value={mode} onChange={setMode} />
        {pay.error && <Alert tone="danger">{pay.error.message}</Alert>}
        <Button type="submit" variant="primary" disabled={paiseOf(text) <= 0 || pay.isPending}>Receive & print receipt</Button>
      </form>
    </Card>
  );
}
