import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PackageX, TrendingDown } from "lucide-react";
import { ADJUST_REASON_LABEL, AdjustReason, expiryLabel, formatINR, itemLabel, type Batch, type Item } from "@ojas/shared";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, Field, Select, cx } from "../../components/ui";
import { formErrors } from "../settings/forms";
import { ItemSearch } from "./ItemSearch";

/** What to act on today (expired, expiring, running low), plus any medicine's batches with stock corrections. */
export function StockPanel() {
  const alerts = useQuery({ queryKey: ["pharmacy-alerts"], queryFn: api.stockAlerts });
  const [item, setItem] = useState<Item | null>(null);
  const a = alerts.data;
  const batchRow = (b: Batch & { itemName: string }, tone: "danger" | "warn") => (
    <li key={b.id} className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate"><strong>{b.itemName}</strong> <span className="text-ink-3">· {b.batchNo}</span></span>
      <span className="tabular-nums text-ink-2">{b.onHand} units</span>
      <Badge tone={tone}>{expiryLabel(b.expiry)}</Badge>
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {alerts.error && <Alert tone="danger">{alerts.error.message}</Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card aria-labelledby="st-exp">
          <h2 id="st-exp" className="flex items-center gap-2 border-b border-line p-4 font-semibold text-danger"><PackageX aria-hidden className="size-4" /> Expired on the shelf <Badge tone="danger">{a?.expired.length ?? 0}</Badge></h2>
          {a?.expired.length === 0 && <p className="p-4 text-sm text-ink-3">Nothing expired. Expired stock is never sold; remove it here when it leaves the shelf.</p>}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">{a?.expired.map((b) => batchRow(b, "danger"))}</ul>
        </Card>
        <Card aria-labelledby="st-soon">
          <h2 id="st-soon" className="flex items-center gap-2 border-b border-line p-4 font-semibold"><AlertTriangle aria-hidden className="size-4 text-warn" /> Expiring in 90 days <Badge tone="warn">{a?.nearExpiry.length ?? 0}</Badge></h2>
          {a?.nearExpiry.length === 0 && <p className="p-4 text-sm text-ink-3">No stock expires in the next 90 days.</p>}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">{a?.nearExpiry.map((b) => batchRow(b, "warn"))}</ul>
        </Card>
        <Card aria-labelledby="st-low">
          <h2 id="st-low" className="flex items-center gap-2 border-b border-line p-4 font-semibold"><TrendingDown aria-hidden className="size-4" /> Running low <Badge>{a?.low.length ?? 0}</Badge></h2>
          {a?.low.length === 0 && <p className="p-4 text-sm text-ink-3">Nothing below its reorder level.</p>}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
            {a?.low.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <button type="button" className="min-w-0 flex-1 truncate text-left font-semibold hover:underline" onClick={() => setItem(i)}>{itemLabel(i)}</button>
                <span className="tabular-nums text-ink-2">{i.onHand} / {i.reorderLevel}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <ItemSearch label="Look up a medicine's batches" onPick={setItem} placeholder="Type a name" />
        {item && <Batches key={item.id} item={item} />}
      </Card>
    </div>
  );
}

function Batches({ item }: { item: Item }) {
  const batches = useQuery({ queryKey: ["pharmacy-batches", item.id], queryFn: () => api.batches(item.id) });
  const [adjusting, setAdjusting] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">{itemLabel(item)} <span className="text-sm font-normal text-ink-3">· pack of {item.packSize}</span></h3>
      {batches.data?.length === 0 && <p className="text-sm text-ink-3">No stock.</p>}
      {!!batches.data?.length && (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-ink-3">
            <th scope="col" className="py-2 font-medium">Batch</th><th scope="col" className="py-2 font-medium">Expiry</th>
            <th scope="col" className="py-2 text-right font-medium">MRP/pack</th><th scope="col" className="py-2 text-right font-medium">In stock</th><th scope="col"><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>
            {batches.data.map((b, n) => (
              <tr key={b.id} className="border-b border-line">
                <td className="py-2 font-medium">{b.batchNo} {n === 0 && !b.expired && <Badge tone="accent">Sells next</Badge>}</td>
                <td className={cx("py-2", b.expired && "font-semibold text-danger")}>{expiryLabel(b.expiry)}{b.expired ? " (expired)" : ""}</td>
                <td className="py-2 text-right tabular-nums">{formatINR(b.mrpPerPack)}</td>
                <td className="py-2 text-right tabular-nums">{b.onHand}</td>
                <td className="py-2 text-right"><Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setAdjusting(adjusting === b.id ? null : b.id)}>Correct stock</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adjusting && batches.data?.find((b) => b.id === adjusting) && (
        <AdjustForm batch={batches.data.find((b) => b.id === adjusting)!} onDone={() => setAdjusting(null)} />
      )}
    </div>
  );
}

function AdjustForm({ batch, onDone }: { batch: Batch; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<AdjustReason>(batch.expired ? "EXPIRED" : "DAMAGED");
  const [qty, setQty] = useState(batch.expired ? String(batch.onHand) : "");
  const [note, setNote] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const adding = reason === "COUNT" && qty.trim().startsWith("+");
  const n = Math.abs(Math.round(Number(qty.replace("+", "")) || 0));
  const save = useMutation({
    mutationFn: () => api.adjustStock({ batchId: batch.id, qty: adding ? n : -n, reason, note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pharmacy-batches"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-alerts"] });
      void qc.invalidateQueries({ queryKey: ["pharmacy-items"] });
      onDone();
    },
    onError: (e) => setErrs(formErrors(e)),
  });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <h4 className="font-semibold">Correct stock: batch {batch.batchNo} ({batch.onHand} in stock)</h4>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Reason" value={reason} onChange={(e) => setReason(AdjustReason.parse(e.target.value))}>
          {AdjustReason.options.map((r) => <option key={r} value={r}>{ADJUST_REASON_LABEL[r]}</option>)}
        </Select>
        <Field label="Units to remove" hint={reason === "COUNT" ? "Start with + to add units found in a count" : undefined} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} error={errs.qty} />
        <Field label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {save.error && !errs.qty && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!n || save.isPending} onClick={() => save.mutate()}>{adding ? `Add ${n}` : `Remove ${n}`}</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
