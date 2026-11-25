import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  CHARGE_CATEGORY_LABEL, ChargeCategory, WARD_KIND_LABEL, WardKind, expandBeds, formatINR,
  type IpdService, type Ward,
} from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { Alert, Badge, Button, Card, Field, Select, cx } from "../../components/ui";
import { paiseOf } from "./common";

const rupees = (p: number) => (p ? String(p / 100) : "");

/** Wards with their beds and daily rates, and the priced services added to in-patient bills. */
export function WardsPanel() {
  const wards = useQuery({ queryKey: ["ipd-wards", "all"], queryFn: () => api.wards(true) });
  const services = useQuery({ queryKey: ["ipd-services", "all"], queryFn: () => api.ipdServices(true) });
  const [editing, setEditing] = useState<Ward | "new" | null>(null);
  const [editingSvc, setEditingSvc] = useState<IpdService | "new" | null>(null);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card className="flex flex-col" aria-labelledby="wards-h">
        <div className="flex items-center gap-2 border-b border-line p-4">
          <h2 id="wards-h" className="font-semibold">Wards and beds</h2>
          <Button className="ml-auto" onClick={() => setEditing("new")}><Plus aria-hidden className="size-4" /> New ward</Button>
        </div>
        {editing && <WardForm ward={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
        {wards.error && <div className="p-4"><Alert tone="danger">{wards.error.message}</Alert></div>}
        {wards.data?.length === 0 && !editing && <p className="p-4 text-ink-3">No wards yet. Add one for each ward or room type, with its daily charge.</p>}
        <ul className="divide-y divide-line">
          {wards.data?.map((w) => (
            <li key={w.id}>
              <button type="button" onClick={() => setEditing(w)} className={cx("flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-4 text-left hover:bg-surface-2", !w.active && "opacity-60")}>
                <span className="min-w-40 flex-1">
                  <span className="block font-semibold">{w.name} {!w.active && <Badge>Not in use</Badge>}</span>
                  <span className="block text-sm text-ink-2">{WARD_KIND_LABEL[w.kind]} · {w.beds.filter((b) => b.active).length} beds: {w.beds.filter((b) => b.active).map((b) => b.label).join(", ")}</span>
                </span>
                <span className="text-sm tabular-nums">{formatINR(w.bedCharge)}/day{w.nursingCharge ? ` + ${formatINR(w.nursingCharge)} nursing` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="flex flex-col" aria-labelledby="svc-h">
        <div className="flex items-center gap-2 border-b border-line p-4">
          <h2 id="svc-h" className="font-semibold">Services and charges</h2>
          <Button className="ml-auto" onClick={() => setEditingSvc("new")}><Plus aria-hidden className="size-4" /> New service</Button>
        </div>
        <p className="px-4 pt-3 text-sm text-ink-3">Doctor visits, procedures, oxygen and the like, so the desk can add them to a bill in one click. Any other charge can still be typed in.</p>
        {editingSvc && <ServiceForm service={editingSvc === "new" ? null : editingSvc} onDone={() => setEditingSvc(null)} />}
        <ul className="divide-y divide-line">
          {services.data?.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setEditingSvc(s)} className={cx("flex w-full items-center gap-3 p-4 text-left hover:bg-surface-2", !s.active && "opacity-60")}>
                <span className="flex-1"><span className="font-semibold">{s.name}</span> <span className="text-sm text-ink-3">· {CHARGE_CATEGORY_LABEL[s.category]}</span> {!s.active && <Badge>Not in use</Badge>}</span>
                <span className="tabular-nums">{formatINR(s.price)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function WardForm({ ward, onDone }: { ward: Ward | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ward?.name ?? "");
  const [kind, setKind] = useState<WardKind>(ward?.kind ?? "GENERAL");
  const [bed, setBed] = useState(rupees(ward?.bedCharge ?? 0));
  const [nursing, setNursing] = useState(rupees(ward?.nursingCharge ?? 0));
  const [beds, setBeds] = useState(ward ? ward.beds.filter((b) => b.active).map((b) => b.label).join(", ") : "");
  const [active, setActive] = useState(ward?.active ?? true);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const list = expandBeds(beds);
  const save = useMutation({
    mutationFn: () => {
      const input = { name, kind, bedCharge: paiseOf(bed), nursingCharge: paiseOf(nursing), beds: list, active };
      return ward ? api.updateWard(ward.id, input) : api.createWard(input);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ipd-wards"] });
      onDone();
    },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  return (
    <form className="flex flex-col gap-3 border-b border-line bg-surface-2/50 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ward name" value={name} autoFocus onChange={(e) => setName(e.target.value)} error={errs.name} placeholder="General ward, Room 3…" />
        <Select label="Type" value={kind} onChange={(e) => setKind(WardKind.parse(e.target.value))}>
          {WardKind.options.map((k) => <option key={k} value={k}>{WARD_KIND_LABEL[k]}</option>)}
        </Select>
        <Field label="Bed charge ₹ per day" inputMode="decimal" value={bed} onChange={(e) => setBed(e.target.value)} error={errs.bedCharge} />
        <Field label="Nursing charge ₹ per day" inputMode="decimal" value={nursing} onChange={(e) => setNursing(e.target.value)} error={errs.nursingCharge} hint="Leave empty if included" />
      </div>
      <Field label="Beds" value={beds} onChange={(e) => setBeds(e.target.value)} error={errs.beds} placeholder="G1-G10, or 101, 102, 103"
        hint={list.length ? `${list.length} bed${list.length === 1 ? "" : "s"}: ${list.slice(0, 12).join(", ")}${list.length > 12 ? "…" : ""}` : "Name each bed; a range like G1-G10 adds ten"} />
      {ward && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4" /> In use
        </label>
      )}
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>Save ward</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ServiceForm({ service, onDone }: { service: IpdService | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(service?.name ?? "");
  const [category, setCategory] = useState<ChargeCategory>(service?.category ?? "DOCTOR");
  const [price, setPrice] = useState(rupees(service?.price ?? 0));
  const [active, setActive] = useState(service?.active ?? true);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => {
      const input = { name, category, price: paiseOf(price), active };
      return service ? api.updateService(service.id, input) : api.createService(input);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ipd-services"] });
      onDone();
    },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  return (
    <form className="flex flex-col gap-3 border-b border-line bg-surface-2/50 p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem_8rem]">
        <Field label="Service" value={name} autoFocus onChange={(e) => setName(e.target.value)} error={errs.name} placeholder="Doctor visit, Dressing…" />
        <Select label="Kind" value={category} onChange={(e) => setCategory(ChargeCategory.parse(e.target.value))}>
          {ChargeCategory.options.map((c) => <option key={c} value={c}>{CHARGE_CATEGORY_LABEL[c]}</option>)}
        </Select>
        <Field label="Price ₹" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={errs.price} />
      </div>
      {service && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4" /> In use
        </label>
      )}
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>Save service</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
