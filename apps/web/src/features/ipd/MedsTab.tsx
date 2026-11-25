import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Ban, Check, Plus } from "lucide-react";
import {
  DOSE_STATUS_LABEL, FREQUENCIES, MED_TIMING_LABEL, MedTiming, ROUTE_LABEL, Route,
  type Admission, type DoseStatus, type MedOrder, type MedOrderInput,
} from "@ojas/shared";
import { api, ApiError, dateTimeLabel, timeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, Select } from "../../components/ui";
import { medLine } from "../consult/Prescription";
import { useAdmissionUpdate } from "./AdmissionView";

/** The treatment chart: the doctor orders and stops medicines; nurses record each dose as they give it. */
export function MedsTab({ admission: a }: { admission: Admission }) {
  const { can } = useAuth();
  const open = a.status === "ADMITTED";
  const [adding, setAdding] = useState(false);
  const active = a.meds.filter((m) => !m.stoppedAt);
  const stopped = a.meds.filter((m) => m.stoppedAt);
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col" aria-labelledby="meds-h">
        <div className="flex items-center gap-2 border-b border-line p-4">
          <h2 id="meds-h" className="font-semibold">Current medicines</h2>
          {open && can("ipd.orders") && !adding && <Button className="ml-auto" onClick={() => setAdding(true)}><Plus aria-hidden className="size-4" /> Add medicine</Button>}
        </div>
        {adding && <AddMed admission={a} onDone={() => setAdding(false)} />}
        {active.length === 0 && !adding && <p className="p-4 text-sm text-ink-3">No medicines on the chart.</p>}
        <ul className="divide-y divide-line">
          {active.map((m) => <MedRow key={m.id} med={m} open={open} />)}
        </ul>
      </Card>
      {stopped.length > 0 && (
        <Card className="flex flex-col" aria-labelledby="stopped-h">
          <h2 id="stopped-h" className="border-b border-line p-4 font-semibold text-ink-2">Stopped</h2>
          <ul className="divide-y divide-line">
            {stopped.map((m) => (
              <li key={m.id} className="p-4 text-sm text-ink-2">
                <span className="line-through">{m.med.drug} · {medLine(m.med)}</span> <span className="text-xs">({ROUTE_LABEL[m.med.route]})</span>
                <div className="text-xs text-ink-3">Started {dateTimeLabel(m.startedAt)} by {m.startedBy} · stopped {dateTimeLabel(m.stoppedAt!)} by {m.stoppedBy}{m.stopReason ? `: ${m.stopReason}` : ""} · {m.doses.filter((d) => d.status === "GIVEN").length} doses given</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function MedRow({ med: m, open }: { med: MedOrder; open: boolean }) {
  const { can } = useAuth();
  const updated = useAdmissionUpdate();
  const [skip, setSkip] = useState<DoseStatus | null>(null);
  const [note, setNote] = useState("");
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState(false);
  const dose = useMutation({
    mutationFn: (status: DoseStatus) => api.recordDose(m.id, { status, note: status === "GIVEN" ? "" : note }),
    onSuccess: (x) => { updated(x); setSkip(null); setNote(""); },
  });
  const stop = useMutation({ mutationFn: () => api.stopMed(m.id, reason), onSuccess: updated });
  const last = m.doses[0];
  const today = new Date().toDateString();
  const givenToday = m.doses.filter((d) => d.status === "GIVEN" && new Date(d.at).toDateString() === today).length;
  const err = dose.error ?? stop.error;
  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-56 flex-1">
          <div className="font-semibold">{m.med.drug} <Badge>{ROUTE_LABEL[m.med.route]}</Badge></div>
          <div className="text-sm text-ink-2">{[m.med.dose, m.med.frequency, MED_TIMING_LABEL[m.med.timing], m.med.durationDays ? `${m.med.durationDays} days` : "", m.med.instructions].filter(Boolean).join(" · ")}</div>
          <div className="text-xs text-ink-3">
            {last ? `Last: ${DOSE_STATUS_LABEL[last.status].toLowerCase()} ${dateTimeLabel(last.at)} by ${last.by}` : "No doses yet"} · {givenToday} given today
          </div>
        </div>
        {open && can("ipd.chart") && (
          <div className="flex flex-wrap gap-1">
            <Button variant="primary" disabled={dose.isPending} onClick={() => dose.mutate("GIVEN")}><Check aria-hidden className="size-4" /> Given</Button>
            <Button onClick={() => setSkip(skip === "HELD" ? null : "HELD")} aria-pressed={skip === "HELD"}>Held</Button>
            <Button onClick={() => setSkip(skip === "REFUSED" ? null : "REFUSED")} aria-pressed={skip === "REFUSED"}>Refused</Button>
          </div>
        )}
        {open && can("ipd.orders") && <Button variant="ghost" onClick={() => setStopping((s) => !s)} aria-expanded={stopping}><Ban aria-hidden className="size-4" /> Stop</Button>}
        {m.doses.length > 0 && <Button variant="ghost" onClick={() => setHistory((h) => !h)} aria-expanded={history}>{history ? "Hide" : "Doses"}</Button>}
      </div>
      {skip && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); dose.mutate(skip); }}>
          <Field label={`Why was it ${skip === "HELD" ? "held" : "refused"}?`} className="min-w-64 flex-1" value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
          <Button type="submit" variant="primary" disabled={note.trim().length < 3 || dose.isPending}>Record</Button>
        </form>
      )}
      {stopping && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); stop.mutate(); }}>
          <Field label="Reason (optional)" className="min-w-64 flex-1" value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Course complete, changed to oral…" />
          <Button type="submit" variant="danger" disabled={stop.isPending}>Stop medicine</Button>
        </form>
      )}
      {err && <Alert tone="danger">{err.message}</Alert>}
      {history && (
        <ol className="flex flex-col gap-1 rounded-lg bg-surface-2 p-3 text-sm">
          {m.doses.map((d) => (
            <li key={d.id} className="flex flex-wrap gap-2">
              <span className="w-32 text-ink-3">{new Date(d.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, {timeLabel(d.at)}</span>
              <span className={d.status === "GIVEN" ? "text-ok" : "text-warn"}>{DOSE_STATUS_LABEL[d.status]}</span>
              <span className="text-ink-2">{d.by}</span>
              {d.note && <span className="text-ink-2">· {d.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

const blank: MedOrderInput = { drug: "", dose: "", frequency: "", timing: "ANY", route: "ORAL", durationDays: null, instructions: "" };

function AddMed({ admission: a, onDone }: { admission: Admission; onDone: () => void }) {
  const updated = useAdmissionUpdate();
  const [m, setM] = useState<MedOrderInput>(blank);
  const set = (p: Partial<MedOrderInput>) => setM((x) => ({ ...x, ...p }));
  const add = useMutation({ mutationFn: () => api.addMed(a.id, m), onSuccess: (x) => { updated(x); onDone(); } });
  const errs = add.error instanceof ApiError ? add.error.fields : {};
  return (
    <form className="flex flex-col gap-3 border-b border-line bg-surface-2/50 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <datalist id="ipd-frequencies">{[...FREQUENCIES, "Stat", "Q6H", "Q8H", "Q12H"].map((f) => <option key={f} value={f} />)}</datalist>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_8rem_9rem_6rem]">
        <Field label="Medicine" value={m.drug} autoFocus onChange={(e) => set({ drug: e.target.value })} error={errs.drug} placeholder="Inj. Ceftriaxone" />
        <Field label="Dose" value={m.dose ?? ""} onChange={(e) => set({ dose: e.target.value })} placeholder="1 g" />
        <Field label="When" value={m.frequency ?? ""} list="ipd-frequencies" onChange={(e) => set({ frequency: e.target.value })} placeholder="1-0-1, Q8H" />
        <Select label="Route" value={m.route} onChange={(e) => set({ route: Route.parse(e.target.value) })}>
          {Route.options.map((r) => <option key={r} value={r}>{ROUTE_LABEL[r]}</option>)}
        </Select>
        <Select label="Food" value={m.timing} onChange={(e) => set({ timing: MedTiming.parse(e.target.value) })}>
          {MedTiming.options.map((t) => <option key={t} value={t}>{MED_TIMING_LABEL[t] || "Any time"}</option>)}
        </Select>
        <Field label="Days" inputMode="numeric" value={m.durationDays == null ? "" : String(m.durationDays)} error={errs.durationDays}
          onChange={(e) => set({ durationDays: e.target.value === "" ? null : Number(e.target.value) || null })} />
      </div>
      <Field label="Instructions" value={m.instructions ?? ""} onChange={(e) => set({ instructions: e.target.value })} placeholder="Slow IV over 30 min, check BP before…" />
      {add.error && !Object.keys(errs).length && <Alert tone="danger">{add.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={add.isPending || m.drug.trim().length < 2}>Add to chart</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
