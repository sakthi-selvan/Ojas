import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { formatINR, GST_RATES, itemLabel, purchaseLineCost, type GstRate, type Item, type PurchaseSummary } from "@ojas/shared";
import { api, ApiError, dateLabel, today } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Button, Card, Field, Select, cx } from "../../components/ui";
import { formErrors, toPaise } from "../settings/forms";
import { ItemSearch } from "./ItemSearch";

interface Row { item: Item; batchNo: string; expiry: string; packs: string; freePacks: string; rate: string; mrp: string; gstRate: GstRate }

/** Receiving stock: type the supplier's invoice as printed, pack by pack. */
export function PurchasePanel() {
  const list = useQuery({ queryKey: ["pharmacy-purchases"], queryFn: api.purchases });
  const [entering, setEntering] = useState(false);
  const [done, setDone] = useState<PurchaseSummary | null>(null);
  if (entering) return <PurchaseForm onDone={(p) => { setDone(p); setEntering(false); }} onCancel={() => setEntering(false)} />;
  return (
    <div className="flex flex-col gap-4">
      {done && <Alert tone="ok">{done.purchaseNo}: {done.lines} line{done.lines === 1 ? "" : "s"} from {done.supplierName} received into stock ({formatINR(done.total)}).</Alert>}
      <div><Button variant="primary" onClick={() => { setDone(null); setEntering(true); }}><Plus aria-hidden className="size-4" /> Receive a supplier invoice</Button></div>
      <Card>
        <h2 className="border-b border-line p-4 font-semibold">Recent purchases</h2>
        {list.data?.length === 0 && <p className="p-4 text-sm text-ink-3">Nothing received yet.</p>}
        {!!list.data?.length && (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-ink-3">
              <th scope="col" className="p-3 font-medium">GRN</th><th scope="col" className="p-3 font-medium">Supplier</th><th scope="col" className="p-3 font-medium">Invoice</th>
              <th scope="col" className="p-3 text-right font-medium">Lines</th><th scope="col" className="p-3 text-right font-medium">Total</th>
            </tr></thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className="p-3 font-medium">{p.purchaseNo}</td>
                  <td className="p-3">{p.supplierName}</td>
                  <td className="p-3">{p.invoiceNo} · {dateLabel(p.invoiceDate)}</td>
                  <td className="p-3 text-right tabular-nums">{p.lines}</td>
                  <td className="p-3 text-right tabular-nums">{formatINR(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function PurchaseForm({ onDone, onCancel }: { onDone: (p: PurchaseSummary) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["pharmacy-suppliers"], queryFn: api.suppliers });
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [addingSupplier, setAddingSupplier] = useState(false);
  const idemKey = useRef(crypto.randomUUID());
  const batchRefs = useRef<(HTMLInputElement | null)[]>([]);

  const lines = rows.map((r) => ({
    itemId: r.item.id, batchNo: r.batchNo, expiry: r.expiry, packs: Number(r.packs) || 0, freePacks: Number(r.freePacks) || 0,
    ratePerPack: toPaise(r.rate), mrpPerPack: toPaise(r.mrp), gstRate: r.gstRate,
  }));
  const costs = lines.map(purchaseLineCost);
  const taxable = costs.reduce((s, c) => s + c.taxable, 0);
  const tax = costs.reduce((s, c) => s + c.tax, 0);

  const save = useMutation({
    mutationFn: () => api.receivePurchase({ supplierId, invoiceNo, invoiceDate, lines, idempotencyKey: idemKey.current }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["pharmacy-purchases"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-items"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-alerts"] });
      onDone(p);
    },
    onError: (e) => {
      setErrs(formErrors(e));
      if (e instanceof ApiError && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });
  useHotkeys({ F9: () => rows.length && !save.isPending && save.mutate() });

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cell = (i: number, key: keyof Row, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => {
    const err = errs[`lines.${i}.${key === "rate" ? "ratePerPack" : key === "mrp" ? "mrpPerPack" : key}`];
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={`pl-${i}-${key}`} className="text-xs font-medium text-ink-2">{label}</label>
        <input
          id={`pl-${i}-${key}`}
          value={rows[i]![key] as string}
          onChange={(e) => set(i, { [key]: e.target.value } as Partial<Row>)}
          aria-invalid={err ? true : undefined}
          className={cx("min-h-10 w-full rounded-lg border bg-surface px-2 text-sm tabular-nums", err ? "border-danger" : "border-line")}
          {...props}
        />
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    );
  };

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-bold">Receive a supplier invoice</h2>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <div className="flex items-end gap-2">
          <Select label="Supplier" className="flex-1" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} error={errs.supplierId}>
            <option value="">Choose…</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button onClick={() => setAddingSupplier(true)}>New</Button>
        </div>
        <Field label="Invoice no." value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} error={errs.invoiceNo} />
        <Field label="Invoice date" type="date" value={invoiceDate} max={today()} onChange={(e) => setInvoiceDate(e.target.value)} error={errs.invoiceDate} />
      </div>
      {addingSupplier && <SupplierForm onSaved={(id) => { setSupplierId(id); setAddingSupplier(false); }} onCancel={() => setAddingSupplier(false)} />}

      <ItemSearch
        label="Add a medicine from the invoice"
        placeholder="Type the name; new medicines are added under Medicines"
        showStock={false}
        onPick={(item) => {
          setRows((rs) => [...rs, { item, batchNo: "", expiry: "", packs: "", freePacks: "", rate: "", mrp: item.mrpPerPack ? String(item.mrpPerPack / 100) : "", gstRate: item.gstRate }]);
          setTimeout(() => batchRefs.current[rows.length]?.focus(), 0);
        }}
      />
      {errs.lines && <Alert tone="danger">{errs.lines}</Alert>}

      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => {
          const c = costs[i]!;
          return (
            <li key={i} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{itemLabel(r.item)}</span>
                <span className="text-xs text-ink-3">pack of {r.item.packSize}</span>
                <span className="ml-auto text-sm tabular-nums text-ink-2">{formatINR(c.taxable)} + GST {formatINR(c.tax)}</span>
                <Button variant="ghost" aria-label={`Remove ${itemLabel(r.item)}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 aria-hidden className="size-4" /></Button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor={`pl-${i}-batchNo`} className="text-xs font-medium text-ink-2">Batch</label>
                  <input
                    id={`pl-${i}-batchNo`}
                    ref={(el) => { batchRefs.current[i] = el; }}
                    value={r.batchNo}
                    onChange={(e) => set(i, { batchNo: e.target.value.toUpperCase() })}
                    aria-invalid={errs[`lines.${i}.batchNo`] ? true : undefined}
                    className={cx("min-h-10 w-full rounded-lg border bg-surface px-2 text-sm", errs[`lines.${i}.batchNo`] ? "border-danger" : "border-line")}
                  />
                  {errs[`lines.${i}.batchNo`] && <span className="text-xs text-danger">{errs[`lines.${i}.batchNo`]}</span>}
                </div>
                {cell(i, "expiry", "Expiry", { type: "month", min: today().slice(0, 7) })}
                {cell(i, "packs", "Packs", { type: "number", min: 1, inputMode: "numeric" })}
                {cell(i, "freePacks", "Free", { type: "number", min: 0, inputMode: "numeric" })}
                {cell(i, "rate", "Rate/pack ₹", { inputMode: "decimal" })}
                {cell(i, "mrp", "MRP/pack ₹", { inputMode: "decimal" })}
                <div className="flex flex-col gap-0.5">
                  <label htmlFor={`pl-${i}-gst`} className="text-xs font-medium text-ink-2">GST</label>
                  <select id={`pl-${i}-gst`} value={r.gstRate} onChange={(e) => set(i, { gstRate: Number(e.target.value) as GstRate })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm">
                    {GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}
                  </select>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {save.error && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
        <dl className="flex gap-6 text-sm">
          <div><dt className="text-ink-3">Before GST</dt><dd className="font-semibold tabular-nums">{formatINR(taxable)}</dd></div>
          <div><dt className="text-ink-3">GST</dt><dd className="font-semibold tabular-nums">{formatINR(tax)}</dd></div>
          <div><dt className="text-ink-3">Invoice total</dt><dd className="text-lg font-bold tabular-nums">{formatINR(taxable + tax)}</dd></div>
        </dl>
        <span className="text-xs text-ink-3">Check the total matches the printed invoice before saving.</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!rows.length || save.isPending} shortcut="F9">{save.isPending ? "Saving…" : "Receive into stock"}</Button>
        </div>
      </div>
    </Card>
  );
}

function SupplierForm({ onSaved, onCancel }: { onSaved: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", gstin: "", drugLicence: "", phone: "", address: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.createSupplier(f),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: ["pharmacy-suppliers"] }); onSaved(s.id); },
    onError: (e) => setErrs(formErrors(e)),
  });
  const field = (k: keyof typeof f, label: string) => (
    <Field label={label} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} error={errs[k]} />
  );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <h3 className="font-semibold">New supplier</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", "Name")}{field("gstin", "GSTIN")}{field("drugLicence", "Drug licence no.")}{field("phone", "Phone")}
      </div>
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2"><Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save supplier</Button><Button onClick={onCancel}>Cancel</Button></div>
    </div>
  );
}
