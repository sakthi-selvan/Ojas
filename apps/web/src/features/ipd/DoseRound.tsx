import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Pill } from "lucide-react";
import {
  ROUTE_LABEL, SLOT_STATE_LABEL, doseCounts, doseSlots, doseTiming,
  type DoseSlot, type DoseStatus, type MedOrder, type WardMeds,
} from "@ojas/shared";
import { api, timeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, cx } from "../../components/ui";
import { useAdmissionUpdate } from "./AdmissionView";

/** The time, ticking each minute, so a dose turns "due" and then "overdue" without a reload. */
export function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Every admitted patient's running medicines, for the dose round and the bed board's counts. */
export const useWardDoses = (enabled = true) =>
  useQuery({ queryKey: ["ipd-doses"], queryFn: api.wardDoses, enabled, refetchInterval: 5 * 60_000 });

const chipTone: Record<DoseSlot["state"], string> = {
  DONE: "border-ok/40 bg-ok-soft text-ok",
  DUE: "border-accent bg-accent-soft text-accent font-semibold",
  LATE: "border-danger/50 bg-danger-soft text-danger font-semibold",
  LATER: "border-line text-ink-3",
};

/** Today's (and any overdue) dose times for one medicine, coloured by state. */
export function DoseTimes({ med, now }: { med: MedOrder; now: Date }) {
  const timing = doseTiming(med.med.frequency);
  if (timing.kind === "as-needed") return <span className="text-xs text-ink-3">When needed, no fixed times</span>;
  const slots = doseSlots(med, now);
  if (!slots.length) return <span className="text-xs text-ink-3">No more doses due today</span>;
  const today = now.toDateString();
  return (
    <ul className="flex flex-wrap gap-1" aria-label={`Dose times for ${med.med.drug}`}>
      {slots.map((s) => {
        const d = new Date(s.at);
        const when = `${d.toDateString() === today ? "" : "yesterday "}${timeLabel(s.at)}`;
        const what = s.dose ? `${s.dose.status === "GIVEN" ? "given" : s.dose.status.toLowerCase()} ${timeLabel(s.dose.at)}` : SLOT_STATE_LABEL[s.state].toLowerCase();
        return (
          <li key={s.at} className={cx("rounded-md border px-1.5 py-0.5 text-xs tabular-nums", chipTone[s.state])} title={`${when}: ${what}`}>
            {s.state === "DONE" && <Check aria-hidden className="mr-0.5 inline size-3" />}
            {when}<span className="sr-only">: {what}</span>
            {s.state === "LATE" && <span aria-hidden> · overdue</span>}
            {s.state === "DUE" && <span aria-hidden> · due</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Due-now and overdue counts as badges; nothing when all is on time. */
export function DoseBadges({ meds, now }: { meds: MedOrder[]; now: Date }) {
  const { due, late } = doseCounts(meds, now);
  return (
    <>
      {late > 0 && <Badge tone="danger">{late} overdue</Badge>}
      {due > 0 && <Badge tone="accent">{due} due</Badge>}
    </>
  );
}

/**
 * The nurses' dose round: every admitted patient with a dose due now or overdue, medicine by
 * medicine, recorded in one click. Patients with nothing pending are listed below.
 */
export function DoseRound({ onOpen }: { onOpen: (admissionId: string) => void }) {
  const now = useNow();
  const ward = useWardDoses();
  if (ward.error) return <Alert tone="danger">{ward.error.message}</Alert>;
  if (!ward.data) return <p className="text-ink-3">Loading medicines…</p>;
  const pending = (w: WardMeds) => w.meds.filter((m) => doseSlots(m, now).some((s) => s.state === "DUE" || s.state === "LATE"));
  const withDue = ward.data.filter((w) => pending(w).length > 0);
  const rest = ward.data.filter((w) => !pending(w).length);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-2">
        Doses due within the hour, and any not recorded in the last day. Times follow the ward round:
        1-0-1 is 8 am and 8 pm, TDS 8, 2 and 8, Q8H 6, 2 and 10.
      </p>
      {withDue.length === 0 && <Alert tone="ok">No doses due or overdue right now.</Alert>}
      {withDue.map((w) => (
        <Card key={w.admissionId} className="flex flex-col" aria-labelledby={`round-${w.admissionId}`}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
            <h2 id={`round-${w.admissionId}`} className="font-semibold">{w.bedLabel} · {w.patient.name}</h2>
            <span className="text-sm text-ink-3">{w.wardName} · {w.admissionNo}</span>
            <DoseBadges meds={w.meds} now={now} />
            <Button variant="ghost" className="ml-auto" onClick={() => onOpen(w.admissionId)}>Open chart</Button>
          </div>
          <ul className="divide-y divide-line">
            {pending(w).map((m) => <RoundRow key={m.id} med={m} now={now} />)}
          </ul>
        </Card>
      ))}
      {rest.length > 0 && (
        <Card aria-labelledby="round-rest">
          <h2 id="round-rest" className="border-b border-line p-4 font-semibold text-ink-2">Nothing pending</h2>
          <ul className="divide-y divide-line">
            {rest.map((w) => (
              <li key={w.admissionId}>
                <button type="button" onClick={() => onOpen(w.admissionId)} className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left text-sm hover:bg-surface-2">
                  <span className="font-semibold">{w.bedLabel} · {w.patient.name}</span>
                  <span className="text-ink-3">{w.meds.length ? `${w.meds.length} medicine${w.meds.length === 1 ? "" : "s"} on the chart` : "No medicines on the chart"}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RoundRow({ med: m, now }: { med: MedOrder; now: Date }) {
  const { can } = useAuth();
  const updated = useAdmissionUpdate();
  const [skip, setSkip] = useState<DoseStatus | null>(null);
  const [note, setNote] = useState("");
  const dose = useMutation({
    mutationFn: (status: DoseStatus) => api.recordDose(m.id, { status, note: status === "GIVEN" ? "" : note }),
    onSuccess: (a) => { updated(a); setSkip(null); setNote(""); },
  });
  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-56 flex-1">
          <div className="flex items-center gap-2 font-semibold"><Pill aria-hidden className="size-4 text-ink-3" /> {m.med.drug} <Badge>{ROUTE_LABEL[m.med.route]}</Badge></div>
          <div className="text-sm text-ink-2">{[m.med.dose, m.med.frequency, m.med.instructions].filter(Boolean).join(" · ")}</div>
          <div className="mt-1"><DoseTimes med={m} now={now} /></div>
        </div>
        {can("ipd.chart") && (
          <div className="flex flex-wrap gap-1">
            <Button variant="primary" disabled={dose.isPending} onClick={() => dose.mutate("GIVEN")}><Check aria-hidden className="size-4" /> Given</Button>
            <Button onClick={() => setSkip(skip === "HELD" ? null : "HELD")} aria-pressed={skip === "HELD"}>Held</Button>
            <Button onClick={() => setSkip(skip === "REFUSED" ? null : "REFUSED")} aria-pressed={skip === "REFUSED"}>Refused</Button>
          </div>
        )}
      </div>
      {skip && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); dose.mutate(skip); }}>
          <Field label={`Why was it ${skip === "HELD" ? "held" : "refused"}?`} className="min-w-64 flex-1" value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
          <Button type="submit" variant="primary" disabled={note.trim().length < 3 || dose.isPending}>Record</Button>
        </form>
      )}
      {dose.error && <Alert tone="danger">{dose.error.message}</Alert>}
    </li>
  );
}
