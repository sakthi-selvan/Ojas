import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRightLeft, ClipboardList, FileText, Pill, Printer, Receipt } from "lucide-react";
import { formatINR, type Admission } from "@ojas/shared";
import { api, ApiError, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, Field, Select, cx } from "../../components/ui";
import { ageSex } from "./common";
import { dayOfStay } from "./BedBoard";
import { ChartTab } from "./ChartTab";
import { MedsTab } from "./MedsTab";
import { BillTab } from "./BillTab";
import { DischargeTab } from "./DischargeTab";
import { useIpdPrint } from "./printables";

type Tab = "chart" | "meds" | "bill" | "discharge";

/** One in-patient: the chart, the treatment chart, the running bill, and discharge. */
export function AdmissionView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["ipd-admission", id], queryFn: () => api.admission(id), refetchInterval: 60_000 });
  const [tab, setTab] = useState<Tab>(() => (can("ipd.chart") || can("ipd.orders") ? "chart" : "bill"));
  const [moving, setMoving] = useState(false);
  const { print, view } = useIpdPrint();
  useHotkeys({ Escape: !moving && onClose });
  const a = q.data;
  if (q.error) return <div className="p-4"><Alert tone="danger">{q.error.message}</Alert></div>;
  if (!a) return <p className="p-6 text-ink-3">Loading…</p>;
  const open = a.status === "ADMITTED";
  const tabs: { id: Tab; label: string; icon: typeof Pill; badge?: string }[] = [
    { id: "chart", label: "Chart", icon: ClipboardList },
    { id: "meds", label: "Medicines", icon: Pill, badge: String(a.meds.filter((m) => !m.stoppedAt).length || "") },
    { id: "bill", label: "Bill", icon: Receipt, badge: open ? formatINR(a.bill.subtotal) : undefined },
    { id: "discharge", label: open ? "Discharge" : "Summary", icon: FileText, badge: a.summarySignedAt && open ? "Signed" : undefined },
  ];
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <Button variant="ghost" onClick={onClose} aria-label="Back to beds" shortcut="Esc"><ArrowLeft aria-hidden className="size-4" /></Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              {a.patient.name}
              <span className="text-base font-normal text-ink-3">{a.patient.uhid} · {a.admissionNo}</span>
              {open ? (a.summarySignedAt ? <Badge tone="ok">Discharge advised</Badge> : <Badge tone="accent">Day {dayOfStay(a.admittedAt)}</Badge>) : <Badge>Discharged</Badge>}
            </h1>
            <p className="text-sm text-ink-2">
              {ageSex(a.patient)} · {a.patient.phone} · {a.bed ? `${a.bed.wardName}, bed ${a.bed.label}` : a.stays.at(-1) ? `was in ${a.stays.at(-1)!.wardName}, bed ${a.stays.at(-1)!.bedLabel}` : ""} · {a.doctor.name}
            </p>
            <p className="text-sm text-ink-3">
              Admitted {dateTimeLabel(a.admittedAt)} by {a.admittedBy}{a.dischargedAt ? ` · discharged ${dateTimeLabel(a.dischargedAt)}` : ""} · {a.reason}
              {a.attendant.name && ` · Attendant: ${a.attendant.name}${a.attendant.relation ? ` (${a.attendant.relation})` : ""}${a.attendant.phone ? `, ${a.attendant.phone}` : ""}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {open && can("ipd.admit") && <Button onClick={() => setMoving((m) => !m)} aria-expanded={moving}><ArrowRightLeft aria-hidden className="size-4" /> Move bed</Button>}
            <Button onClick={() => print({ kind: "bill", admission: a })}><Printer aria-hidden className="size-4" /> {open ? "Interim bill" : "Final bill"}</Button>
            {a.summarySignedAt && <Button onClick={() => print({ kind: "summary", admission: a })}><Printer aria-hidden className="size-4" /> Summary</Button>}
          </div>
        </div>
        {moving && <MoveBed admission={a} onDone={() => setMoving(false)} />}
      </Card>

      <div role="tablist" aria-label="Admission" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`adm-tab-${t.id}`}
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`adm-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.id === tab);
              const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : undefined;
              if (next) { setTab(next.id); document.getElementById(`adm-tab-${next.id}`)?.focus(); }
            }}
            className={cx(
              "-mb-px flex min-h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
              tab === t.id ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <t.icon aria-hidden className="size-4" /> {t.label}
            {t.badge && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-ink-2">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`adm-panel-${tab}`} aria-labelledby={`adm-tab-${tab}`}>
        {tab === "chart" && <ChartTab admission={a} />}
        {tab === "meds" && <MedsTab admission={a} />}
        {tab === "bill" && <BillTab admission={a} print={print} />}
        {tab === "discharge" && <DischargeTab admission={a} print={print} />}
      </div>
      {view}
    </div>
  );
}

/** Keeps the screen in step after any change, without waiting for the realtime event. */
export function useAdmissionUpdate() {
  const qc = useQueryClient();
  return (a: Admission) => {
    qc.setQueryData(["ipd-admission", a.id], a);
    void qc.invalidateQueries({ queryKey: ["ipd-wards"] });
    void qc.invalidateQueries({ queryKey: ["ipd-admissions"] });
  };
}

function MoveBed({ admission: a, onDone }: { admission: Admission; onDone: () => void }) {
  const updated = useAdmissionUpdate();
  const wards = useQuery({ queryKey: ["ipd-wards"], queryFn: () => api.wards() });
  const [bedId, setBedId] = useState("");
  const [reason, setReason] = useState("");
  const move = useMutation({ mutationFn: () => api.transfer(a.id, { bedId, reason }), onSuccess: (x) => { updated(x); onDone(); } });
  const fields = move.error instanceof ApiError ? move.error.fields : {};
  const free = (wards.data ?? []).map((w) => ({ ...w, beds: w.beds.filter((b) => b.state === "FREE") })).filter((w) => w.beds.length);
  return (
    <form className="flex flex-wrap items-end gap-3 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); move.mutate(); }}>
      <Select label="New bed" className="min-w-56" value={bedId} onChange={(e) => setBedId(e.target.value)} error={fields.bedId} hint={free.length ? undefined : "No free beds"} autoFocus>
        <option value="">Choose…</option>
        {free.map((w) => (
          <optgroup key={w.id} label={`${w.name} (${formatINR(w.bedCharge)}/day)`}>
            {w.beds.map((b) => <option key={b.id} value={b.id}>{w.name} · {b.label}</option>)}
          </optgroup>
        ))}
      </Select>
      <Field label="Why" className="min-w-64 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} error={fields.reason} placeholder="Needs ICU care, asked for a private room…" />
      <Button type="submit" variant="primary" disabled={!bedId || move.isPending}>Move</Button>
      <Button onClick={onDone}>Cancel</Button>
      {move.error && !Object.keys(fields).length && <div className="w-full"><Alert tone="danger">{move.error.message}</Alert></div>}
      <p className="w-full text-xs text-ink-3">Each night is charged at the rate of the bed the patient is in at midnight. The old bed goes for cleaning.</p>
    </form>
  );
}
