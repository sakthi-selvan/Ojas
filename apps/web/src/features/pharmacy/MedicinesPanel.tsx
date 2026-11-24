import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  DOSAGE_FORM_LABEL, DosageForm, DrugSchedule, GST_RATES, SCHEDULE_LABEL, expiryLabel, itemLabel, type GstRate, type Item, type ItemInput,
} from "@ojas/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, Select } from "../../components/ui";
import { formErrors } from "../settings/forms";
import { scheduleBadge } from "./ItemSearch";

/** The medicine list: what the pharmacy stocks, how it's packed, taxed and scheduled. */
export function MedicinesPanel() {
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const items = useQuery({ queryKey: ["pharmacy-items", "list", q], queryFn: () => api.pharmacyItems(q, { all: true }) });
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const canEdit = can("pharmacy.stock");

  return (
    <div className="flex flex-col gap-4">
      {editing && <Card className="p-4 sm:p-6"><ItemForm item={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} /></Card>}
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <Field label="Search" className="min-w-48 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or generic name" />
          {canEdit && <Button variant="primary" onClick={() => setEditing("new")}><Plus aria-hidden className="size-4" /> Add medicine</Button>}
        </div>
        {items.data?.length === 0 && <p className="p-4 text-sm text-ink-3">{q ? "No match." : "No medicines yet. Add the ones you stock, then receive a supplier invoice."}</p>}
        {!!items.data?.length && (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-ink-3">
              <th scope="col" className="p-3 font-medium">Medicine</th><th scope="col" className="p-3 font-medium">Form</th><th scope="col" className="p-3 font-medium">GST</th>
              <th scope="col" className="p-3 text-right font-medium">In stock</th><th scope="col" className="p-3 font-medium">Next expiry</th><th scope="col"><span className="sr-only">Edit</span></th>
            </tr></thead>
            <tbody>
              {items.data.map((i) => (
                <tr key={i.id} className="border-b border-line">
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">{itemLabel(i)} {scheduleBadge(i.schedule)} {!i.active && <Badge>Not sold</Badge>}</div>
                    {(i.generic || i.manufacturer) && <div className="text-xs text-ink-3">{[i.generic, i.manufacturer].filter(Boolean).join(" · ")}</div>}
                  </td>
                  <td className="p-3">{DOSAGE_FORM_LABEL[i.form]} × {i.packSize}</td>
                  <td className="p-3">{i.gstRate}%</td>
                  <td className="p-3 text-right tabular-nums">{i.onHand}</td>
                  <td className="p-3">{i.nextExpiry ? expiryLabel(i.nextExpiry) : "—"}</td>
                  <td className="p-3 text-right">{canEdit && <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setEditing(i)}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function ItemForm({ item, onDone }: { item?: Item; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: item?.name ?? "", generic: item?.generic ?? "", form: item?.form ?? "TAB", strength: item?.strength ?? "", manufacturer: item?.manufacturer ?? "",
    hsn: item?.hsn ?? "3004", gstRate: item?.gstRate ?? 12, schedule: item?.schedule ?? "NONE", packSize: String(item?.packSize ?? 10),
    reorderLevel: String(item?.reorderLevel ?? 0), active: item?.active ?? true,
  });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const input = (): ItemInput => ({ ...f, packSize: Number(f.packSize) || 0, reorderLevel: Number(f.reorderLevel) || 0 });
  const save = useMutation({
    mutationFn: () => (item ? api.updateItem(item.id, input()) : api.createItem(input())),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["pharmacy-items"] }); onDone(); },
    onError: (e) => setErrs(formErrors(e)),
  });
  const text = (k: "name" | "generic" | "strength" | "manufacturer" | "hsn" | "packSize" | "reorderLevel", label: string, hint?: string) => (
    <Field label={label} hint={hint} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} error={errs[k]} inputMode={k === "packSize" || k === "reorderLevel" || k === "hsn" ? "numeric" : undefined} />
  );
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2 className="text-lg font-bold">{item ? `Edit ${itemLabel(item)}` : "Add a medicine"}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {text("name", "Name", "Brand name as on the strip")}
        {text("strength", "Strength", "e.g. 650 mg, 100 ml")}
        <Select label="Form" value={f.form} onChange={(e) => setF((x) => ({ ...x, form: DosageForm.parse(e.target.value) }))}>
          {DosageForm.options.map((o) => <option key={o} value={o}>{DOSAGE_FORM_LABEL[o]}</option>)}
        </Select>
        {text("generic", "Generic name")}
        {text("manufacturer", "Manufacturer")}
        {text("packSize", "Units per pack", "10 tablets in a strip; 1 for a bottle")}
        <Select label="GST" value={f.gstRate} onChange={(e) => setF((x) => ({ ...x, gstRate: Number(e.target.value) as GstRate }))}>
          {GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}
        </Select>
        {text("hsn", "HSN code")}
        <Select label="Schedule" value={f.schedule} onChange={(e) => setF((x) => ({ ...x, schedule: DrugSchedule.parse(e.target.value) }))} hint={f.schedule !== "NONE" ? "Needs the prescriber's name when sold" : undefined}>
          {DrugSchedule.options.map((s) => <option key={s} value={s}>{SCHEDULE_LABEL[s]}</option>)}
        </Select>
        {text("reorderLevel", "Reorder at (units)", "0 = no low-stock warning")}
        <label className="flex items-center gap-2 self-end pb-3 text-sm">
          <input type="checkbox" checked={f.active} onChange={(e) => setF((x) => ({ ...x, active: e.target.checked }))} /> Sold here
        </label>
      </div>
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>{item ? "Save changes" : "Add medicine"}</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
