import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { NOTE_KIND_LABEL, VITAL_KEYS, type Admission, type NoteKind } from "@ojas/shared";
import { api, ApiError, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, cx } from "../../components/ui";
import { VITAL_FIELDS, toVitalsForm, toVitalsInput, vitalFlag, type VitalsFormState } from "../consult/VitalsForm";
import { LabResults } from "../consult/LabResults";
import { useAdmissionUpdate } from "./AdmissionView";

/** The bedside chart: vitals over time and the doctors' and nurses' notes, with lab results alongside. */
export function ChartTab({ admission: a }: { admission: Admission }) {
  const { can } = useAuth();
  const open = a.status === "ADMITTED";
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_24rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Vitals admission={a} canAdd={open && can("ipd.chart")} />
        <Notes admission={a} canNurse={open && can("ipd.chart")} canDoctor={open && can("ipd.orders")} />
      </div>
      <aside className="flex flex-col gap-4"><LabResults patientId={a.patient.id} /></aside>
    </div>
  );
}

const SHOWN = VITAL_FIELDS.filter((f) => f.key !== "heightCm");

function Vitals({ admission: a, canAdd }: { admission: Admission; canAdd: boolean }) {
  const updated = useAdmissionUpdate();
  const [form, setForm] = useState<VitalsFormState>(() => toVitalsForm());
  const [all, setAll] = useState(false);
  const save = useMutation({
    mutationFn: () => api.addIpdVitals(a.id, toVitalsInput(form)),
    onSuccess: (x) => { updated(x); setForm(toVitalsForm()); },
  });
  const errs = save.error instanceof ApiError ? save.error.fields : {};
  const rows = all ? a.vitals : a.vitals.slice(0, 8);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby="vitals-h">
      <h2 id="vitals-h" className="font-semibold">Vitals</h2>
      {canAdd && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {SHOWN.map((f) => {
              const n = form[f.key] === "" ? null : Number(form[f.key]);
              const fl = n == null || Number.isNaN(n) ? null : vitalFlag(f.key, n);
              return (
                <label key={f.key} className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-2">
                  {f.label}
                  <span className="relative">
                    <input
                      inputMode="decimal"
                      value={form[f.key]}
                      aria-invalid={errs[f.key] ? true : undefined}
                      onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                      className={cx("min-h-10 w-full min-w-0 rounded-lg border bg-surface px-2 pr-9 text-sm tabular-nums", errs[f.key] ? "border-danger" : fl ? "border-warn" : "border-line")}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-3">{f.unit}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {save.error && <Alert tone="danger">{Object.values(errs)[0] ?? save.error.message}</Alert>}
          <div><Button type="submit" variant="primary" disabled={save.isPending || VITAL_KEYS.every((k) => !form[k].trim())}>Record vitals</Button></div>
        </form>
      )}
      {a.vitals.length === 0 ? (
        <p className="text-sm text-ink-3">No vitals recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="py-1 pr-2 font-medium">When</th>
                {SHOWN.map((f) => <th key={f.key} className="py-1 pr-2 font-medium">{f.label}</th>)}
                <th className="py-1 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className="border-b border-line/60">
                  <td className="whitespace-nowrap py-1.5 pr-2 text-ink-2">{dateTimeLabel(v.at)}</td>
                  {SHOWN.map((f) => {
                    const n = v.vitals[f.key];
                    const fl = n == null ? null : vitalFlag(f.key, n);
                    return <td key={f.key} className={cx("py-1.5 pr-2 tabular-nums", fl && "font-semibold text-warn")}>{n ?? "—"}</td>;
                  })}
                  <td className="py-1.5 text-xs text-ink-3">{v.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {a.vitals.length > 8 && !all && <div><Button variant="ghost" onClick={() => setAll(true)}>Show all {a.vitals.length}</Button></div>}
    </Card>
  );
}

function Notes({ admission: a, canNurse, canDoctor }: { admission: Admission; canNurse: boolean; canDoctor: boolean }) {
  const updated = useAdmissionUpdate();
  const kinds: NoteKind[] = [...(canDoctor ? ["DOCTOR" as const] : []), ...(canNurse ? ["NURSING" as const] : [])];
  const [kind, setKind] = useState<NoteKind>(kinds[0] ?? "NURSING");
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<NoteKind | "ALL">("ALL");
  const add = useMutation({ mutationFn: () => api.addNote(a.id, { kind, text }), onSuccess: (x) => { updated(x); setText(""); } });
  const shown = a.notes.filter((n) => filter === "ALL" || n.kind === filter);
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby="notes-h">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="notes-h" className="font-semibold">Notes</h2>
        <div className="ml-auto flex gap-1" role="group" aria-label="Show">
          {(["ALL", "DOCTOR", "NURSING"] as const).map((k) => (
            <Button key={k} variant="ghost" className="min-h-8 px-2 text-xs" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k === "ALL" ? "All" : k === "DOCTOR" ? "Doctors" : "Nursing"}
            </Button>
          ))}
        </div>
      </div>
      {kinds.length > 0 && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          {kinds.length > 1 && (
            <div className="flex gap-2 text-sm" role="radiogroup" aria-label="Note type">
              {kinds.map((k) => (
                <label key={k} className="flex items-center gap-1.5"><input type="radio" name="note-kind" checked={kind === k} onChange={() => setKind(k)} /> {NOTE_KIND_LABEL[k]}</label>
              ))}
            </div>
          )}
          <textarea
            aria-label={NOTE_KIND_LABEL[kind]}
            value={text}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey && text.trim()) { e.preventDefault(); add.mutate(); } }}
            placeholder={kind === "DOCTOR" ? "Progress, findings, plan…" : "Care given, intake/output, how the patient is…"}
            className="rounded-lg border border-line bg-surface p-3 text-base"
          />
          {add.error && <Alert tone="danger">{add.error.message}</Alert>}
          <div><Button type="submit" variant="primary" disabled={add.isPending || text.trim().length < 2} shortcut="Ctrl+Enter">Add note</Button></div>
        </form>
      )}
      {shown.length === 0 ? <p className="text-sm text-ink-3">No notes yet.</p> : (
        <ol className="flex flex-col divide-y divide-line">
          {shown.map((n) => (
            <li key={n.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <Badge tone={n.kind === "DOCTOR" ? "accent" : "neutral"}>{NOTE_KIND_LABEL[n.kind]}</Badge>
                <span>{n.by}</span>
                <span className="ml-auto">{dateTimeLabel(n.at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{n.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
