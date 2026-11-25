import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, BedDouble, ClipboardList, CreditCard, Smartphone, Trash2 } from "lucide-react";
import {
  formatINR, itemLabel, lineAmount, needsPrescriber, type CounterMode, type Item, type PendingPrescription, type PharmacyBill,
} from "@ojas/shared";
import { api, ApiError, timeLabel, today } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, Field, Segmented, Select, cx } from "../../components/ui";
import { ItemSearch, scheduleBadge } from "./ItemSearch";
import { PharmacyBillView } from "./PharmacyBillView";

interface Line { item: Item; qty: number }
interface Customer { name: string; phone: string; prescriber: string; patientId?: string; appointmentId?: string; uhid?: string; admissionId?: string }
const blank: Customer = { name: "", phone: "", prescriber: "" };

/**
 * The pharmacy counter: today's prescriptions on the right (one click loads one), the bill on the
 * left. F2 finds a medicine, F9 bills. Stock is taken from the earliest-expiring batch first.
 */
export function SellPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [customer, setCustomer] = useState<Customer>(blank);
  const [lines, setLines] = useState<Line[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [mode, setMode] = useState<CounterMode>("CASH");
  const [discountText, setDiscountText] = useState("");
  const [bill, setBill] = useState<PharmacyBill | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  /** An error goes away as soon as the field it's about is edited. */
  const fix = (k: string) => setErrs((x) => { if (!(k in x)) return x; const { [k]: _, ...rest } = x; return rest; });
  const search = useRef<HTMLInputElement>(null);
  const idemKey = useRef(crypto.randomUUID());

  const pending = useQuery({ queryKey: ["pharmacy-prescriptions"], queryFn: api.pendingPrescriptions, refetchInterval: 30_000 });
  const sales = useQuery({ queryKey: ["pharmacy-sales", today()], queryFn: () => api.sales(today()) });
  const inpatients = useQuery({ queryKey: ["ipd-inpatients"], queryFn: api.inpatients });
  /** Medicines for an admitted patient go on their in-patient bill, settled at discharge. */
  const ip = customer.admissionId ? inpatients.data?.find((i) => i.admissionId === customer.admissionId) : undefined;
  const payMode: CounterMode = mode === "IPD" && !ip ? "CASH" : mode;

  const canDiscount = can("billing.discount");
  const subtotal = lines.reduce((s, l) => s + (l.item.mrpPerPack != null ? lineAmount(l.item.mrpPerPack, l.qty, l.item.packSize) : 0), 0);
  const discount = canDiscount ? Math.round((Number(discountText.replace(/[^\d.]/g, "")) || 0) * 100) : 0;
  const scheduled = lines.some((l) => needsPrescriber(l.item.schedule));

  const add = (item: Item, qty = item.packSize) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.item.id === item.id);
      return i >= 0 ? ls.map((l, j) => (j === i ? { ...l, qty: l.qty + qty } : l)) : [...ls, { item, qty }];
    });

  const loadPrescription = (p: PendingPrescription) => {
    setCustomer({ name: p.patientName, phone: p.patientPhone, prescriber: p.prescriber, patientId: p.patientId, appointmentId: p.appointmentId, uhid: p.uhid });
    if (mode === "IPD") setMode("CASH");
    setLines(p.lines.filter((l) => l.item).map((l) => ({ item: l.item!, qty: Math.max(1, l.suggestedQty) })));
    setUnmatched(p.lines.filter((l) => !l.item).map((l) => l.drug));
    setErrs({});
  };

  const pickInpatient = (admissionId: string) => {
    const i = inpatients.data?.find((x) => x.admissionId === admissionId);
    if (!i) { setCustomer(blank); setMode("CASH"); return; }
    setCustomer({ name: i.patient.name, phone: i.patient.phone, prescriber: i.doctorName, patientId: i.patient.id, uhid: i.patient.uhid, admissionId: i.admissionId });
    setMode("IPD");
    setErrs({});
  };

  const reset = () => {
    setCustomer(blank);
    setMode("CASH");
    setLines([]);
    setUnmatched([]);
    setDiscountText("");
    setBill(null);
    setErrs({});
    idemKey.current = crypto.randomUUID();
    setTimeout(() => search.current?.focus(), 0);
  };

  const sell = useMutation({
    mutationFn: () =>
      api.sell({
        customerName: customer.name.trim() || "Walk-in customer",
        customerPhone: customer.phone,
        prescriber: customer.prescriber,
        patientId: customer.patientId,
        appointmentId: customer.appointmentId,
        lines: lines.map((l) => ({ itemId: l.item.id, qty: l.qty })),
        discount,
        paymentMode: payMode === "IPD" ? "CASH" : payMode,
        admissionId: payMode === "IPD" ? ip?.admissionId : undefined,
        idempotencyKey: idemKey.current,
      }),
    onSuccess: (b) => {
      setBill(b);
      void qc.invalidateQueries({ queryKey: ["pharmacy-prescriptions"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-sales"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-items"] });
    },
    onError: (e) => {
      setErrs(e instanceof ApiError ? e.fields : {});
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });
  const submit = () => !bill && lines.length > 0 && !sell.isPending && sell.mutate();

  useHotkeys({ F9: submit, F2: () => search.current?.focus() });

  if (bill) return <Card className="p-4 sm:p-6"><PharmacyBillView bill={bill} onNext={reset} /></Card>;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
      <Card className="flex flex-col gap-4 p-4 sm:p-6">
        {(inpatients.data?.length ?? 0) > 0 && (
          <Select label="In-patient (medicines go on the IP bill)" value={customer.admissionId ?? ""} onChange={(e) => pickInpatient(e.target.value)}>
            <option value="">Not an in-patient</option>
            {inpatients.data!.map((i) => <option key={i.admissionId} value={i.admissionId}>{i.patient.name} · {i.wardName} {i.bedLabel} · {i.admissionNo}</option>)}
          </Select>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customer" value={customer.name} onChange={(e) => { fix("customerName"); setCustomer((c) => ({ ...c, name: e.target.value, patientId: undefined, uhid: undefined, admissionId: undefined })); }} placeholder="Walk-in customer" hint={customer.uhid ? `Patient ${customer.uhid}` : undefined} error={errs.customerName} />
          <Field label="Phone (optional)" inputMode="tel" value={customer.phone} onChange={(e) => { fix("customerPhone"); setCustomer((c) => ({ ...c, phone: e.target.value })); }} error={errs.customerPhone} />
          <Field
            label={scheduled ? "Prescribing doctor (required)" : "Prescribing doctor"}
            value={customer.prescriber}
            onChange={(e) => { fix("prescriber"); setCustomer((c) => ({ ...c, prescriber: e.target.value })); }}
            error={errs.prescriber}
            hint={scheduled && !customer.prescriber ? "Needed for Schedule H, H1 and X medicines" : undefined}
          />
        </div>

        <ItemSearch ref={search} label="Add medicine (F2)" placeholder="Type a name, e.g. para" onPick={(i) => add(i)} />

        {unmatched.length > 0 && (
          <Alert tone="warn">Not in the medicine list, add by hand or skip: {unmatched.join(", ")}</Alert>
        )}

        {lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-3">No medicines yet. Search above, or pick one of today's prescriptions.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Medicines on this bill</caption>
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th scope="col" className="py-2 font-medium">Medicine</th>
                <th scope="col" className="w-36 py-2 font-medium">Quantity</th>
                <th scope="col" className="py-2 text-right font-medium">Amount</th>
                <th scope="col"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const short = l.qty > l.item.onHand;
                const err = errs[`lines.${i}.qty`];
                return (
                  <tr key={l.item.id} className="border-b border-line align-top">
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap items-center gap-2 font-semibold">{itemLabel(l.item)} {scheduleBadge(l.item.schedule)}</div>
                      <div className={cx("text-xs", short ? "text-danger" : "text-ink-3")}>{l.item.onHand} in stock · pack of {l.item.packSize}</div>
                    </td>
                    <td className="py-2 pr-2">
                      <label className="sr-only" htmlFor={`qty-${l.item.id}`}>Quantity of {itemLabel(l.item)}</label>
                      <input
                        id={`qty-${l.item.id}`}
                        type="number"
                        min={1}
                        value={l.qty}
                        aria-invalid={short || err ? true : undefined}
                        onChange={(e) => { fix(`lines.${i}.qty`); setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: Math.max(1, Math.round(Number(e.target.value) || 1)) } : x))); }}
                        className={cx("min-h-10 w-24 rounded-lg border bg-surface px-2 tabular-nums", short || err ? "border-danger" : "border-line")}
                      />
                      <div className="text-xs text-ink-3">
                        {l.item.packSize > 1 && l.qty % l.item.packSize === 0 ? `${l.qty / l.item.packSize} pack${l.qty / l.item.packSize === 1 ? "" : "s"}` : "units"}
                      </div>
                      {err && <div className="text-xs text-danger">{err}</div>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{l.item.mrpPerPack != null ? formatINR(lineAmount(l.item.mrpPerPack, l.qty, l.item.packSize)) : "—"}</td>
                    <td className="py-2 pl-2 text-right">
                      <Button variant="ghost" aria-label={`Remove ${itemLabel(l.item)}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Segmented
            label="Payment"
            name="ph-mode"
            value={payMode}
            onChange={setMode}
            options={[
              ...(ip ? [{ value: "IPD" as const, label: "IP bill", icon: <BedDouble aria-hidden className="size-4" /> }] : []),
              { value: "CASH", label: "Cash", icon: <Banknote aria-hidden className="size-4" /> },
              { value: "UPI", label: "UPI", icon: <Smartphone aria-hidden className="size-4" /> },
              { value: "CARD", label: "Card", icon: <CreditCard aria-hidden className="size-4" /> },
            ]}
          />
          {canDiscount && (
            <Field label="Discount ₹" inputMode="decimal" className="sm:w-32" value={discountText} onChange={(e) => setDiscountText(e.target.value)} />
          )}
        </div>

        {/* Errors about a field show beside that field; only the rest need a banner. */}
        {sell.error && !(sell.error instanceof ApiError && Object.keys(sell.error.fields).length) && <Alert tone="danger">{sell.error.message}</Alert>}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <div>
            <div className="text-sm text-ink-2">{payMode === "IPD" ? `Add to IP bill ${ip?.admissionNo}` : "To pay"}{discount > 0 ? ` (after ${formatINR(discount)} off)` : ""}</div>
            <div className="text-3xl font-bold tabular-nums">{formatINR(Math.max(0, subtotal - discount))}</div>
          </div>
          <span className="text-xs text-ink-3">Prices include GST. The bill uses each batch's own MRP.</span>
          <Button variant="primary" size="lg" className="ml-auto" onClick={submit} disabled={!lines.length || sell.isPending} shortcut="F9">
            {sell.isPending ? "Billing…" : payMode === "IPD" ? "Add to IP bill" : "Bill & take payment"}
          </Button>
          {(lines.length > 0 || customer.name) && <Button variant="ghost" onClick={reset}>Clear</Button>}
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Card aria-labelledby="rx-waiting">
          <h2 id="rx-waiting" className="flex items-center gap-2 border-b border-line p-4 font-semibold">
            <ClipboardList aria-hidden className="size-4" /> Prescriptions today
            <Badge tone="warn">{pending.data?.length ?? 0}</Badge>
          </h2>
          {pending.error && <div className="p-3"><Alert tone="danger">{pending.error.message}</Alert></div>}
          {pending.data?.length === 0 && <p className="p-4 text-sm text-ink-3">Signed prescriptions from today's OPD appear here until they're billed.</p>}
          <ul className="divide-y divide-line">
            {pending.data?.map((p) => (
              <li key={p.appointmentId}>
                <button type="button" onClick={() => loadPrescription(p)} className={cx("flex w-full flex-col gap-0.5 p-4 text-left hover:bg-surface-2", customer.appointmentId === p.appointmentId && "bg-accent-soft")}>
                  <span className="flex items-center gap-2 font-semibold">{p.patientName} <span className="text-xs font-normal text-ink-3">{p.uhid}</span></span>
                  <span className="text-xs text-ink-2">{p.prescriber} · signed {timeLabel(p.signedAt)}</span>
                  <span className="truncate text-xs text-ink-3">{p.lines.map((l) => l.drug).join(", ")}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card aria-labelledby="ph-today">
          <h2 id="ph-today" className="border-b border-line p-4 font-semibold">Bills today</h2>
          {sales.data?.length === 0 && <p className="p-4 text-sm text-ink-3">No bills yet today.</p>}
          <ul className="max-h-80 divide-y divide-line overflow-y-auto">
            {sales.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.customerName}</span>
                  <span className="block text-xs text-ink-3">{s.billNo} · {timeLabel(s.issuedAt)}</span>
                </span>
                <span className="tabular-nums">{formatINR(s.total)}</span>
                <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => void api.bill(s.id).then(setBill)}>Open</Button>
              </li>
            ))}
          </ul>
          {sales.data && sales.data.length > 0 && (
            <div className="flex justify-between border-t border-line px-4 py-3 text-sm font-semibold">
              <span>Total today</span>
              <span className="tabular-nums">{formatINR(sales.data.reduce((s, x) => s + x.total, 0))}</span>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
