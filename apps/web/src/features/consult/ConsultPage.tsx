import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BellRing } from "lucide-react";
import type { QueueItem } from "@ojas/shared";
import { api, timeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, Select, cx } from "../../components/ui";
import { statusMeta, useQueue } from "../queue/QueuePanel";
import { ConsultForm } from "./ConsultForm";

const DOCTOR_KEY = "ojas.consultDoctor";
const readDoctor = () => { try { return localStorage.getItem(DOCTOR_KEY); } catch { return null; } };
const saveDoctor = (id: string) => { try { localStorage.setItem(DOCTOR_KEY, id); } catch { /* storage unavailable */ } };
const waiting = (i: QueueItem) => i.status === "BOOKED" || i.status === "CHECKED_IN";

/** The doctor's screen: their patients for today on the left, the consultation on the right. */
export function ConsultPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const doctors = useQuery({ queryKey: ["practitioners"], queryFn: api.practitioners });
  const queue = useQueue();
  const [doctorId, setDoctorId] = useState<string | null>(readDoctor);
  const [selected, setSelected] = useState<string | null>(null);

  // First time on this desk: pick the doctor whose name matches the signed-in user, else the first one.
  useEffect(() => {
    const list = doctors.data;
    if (!list?.length || (doctorId && list.some((d) => d.id === doctorId))) return;
    const words = (user?.displayName ?? "").toLowerCase().replace(/^dr\.?\s*/, "").split(/\s+/).filter((w) => w.length > 2);
    const match = list.find((d) => words.some((w) => d.name.toLowerCase().includes(w)));
    setDoctorId((match ?? list[0]!).id);
  }, [doctors.data, doctorId, user]);

  const mine = useMemo(() => (queue.data ?? []).filter((i) => i.practitionerId === doctorId), [queue.data, doctorId]);
  // Open the patient who is already in with the doctor, if any.
  useEffect(() => {
    if (selected && mine.some((i) => i.appointmentId === selected)) return;
    setSelected(mine.find((i) => i.status === "IN_CONSULT")?.appointmentId ?? null);
  }, [mine, selected]);

  const next = mine.find((i) => i.status === "CHECKED_IN") ?? mine.find((i) => i.status === "BOOKED");
  const callNext = useMutation({
    mutationFn: async () => {
      if (!next) return null;
      await api.setStatus(next.appointmentId, "IN_CONSULT");
      return next.appointmentId;
    },
    onSuccess: (id) => {
      if (id) setSelected(id);
      void qc.invalidateQueries({ queryKey: ["queue"] });
    },
  });
  useHotkeys({ "Alt+N": () => next && !callNext.isPending && callNext.mutate() });

  const left = mine.filter(waiting).length;
  return (
    <div className="mx-auto grid max-w-[1800px] items-start gap-4 p-4 lg:grid-cols-[18rem_1fr] lg:p-6">
      <Card className="flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-7rem)]" aria-labelledby="my-patients">
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <Select
            label="Doctor"
            value={doctorId ?? ""}
            onChange={(e) => {
              setDoctorId(e.target.value);
              saveDoctor(e.target.value);
              setSelected(null);
            }}
          >
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <div className="flex items-center gap-2">
            <h2 id="my-patients" className="font-semibold">Today</h2>
            <Badge tone="warn">{left} waiting</Badge>
          </div>
          <Button variant="primary" onClick={() => callNext.mutate()} disabled={!next || callNext.isPending} shortcut="Alt+N">
            <BellRing aria-hidden className="size-4" /> {next ? `Call #${next.token}` : "No one waiting"}
          </Button>
          {callNext.error && <Alert tone="danger">{callNext.error.message}</Alert>}
        </div>
        <ol className="flex-1 overflow-y-auto p-2" aria-label="Patients">
          {mine.length === 0 && <li className="p-4 text-center text-sm text-ink-3">No appointments today.</li>}
          {mine.map((i) => {
            const meta = statusMeta[i.status];
            return (
              <li key={i.appointmentId}>
                <button
                  type="button"
                  aria-current={selected === i.appointmentId ? "true" : undefined}
                  onClick={() => setSelected(i.appointmentId)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left",
                    selected === i.appointmentId ? "bg-accent-soft" : "hover:bg-surface-2",
                    i.status === "DONE" && "opacity-60",
                  )}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 font-bold tabular-nums">{i.token}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{i.patientName}</span>
                    <span className="flex items-center gap-1 text-xs text-ink-2">
                      {timeLabel(i.slotStart)}
                      {i.vitalsRecorded && <><span aria-hidden>·</span><Activity aria-hidden className="size-3 text-ok" /><span>Vitals</span></>}
                    </span>
                  </span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                </button>
              </li>
            );
          })}
        </ol>
      </Card>
      <div className="min-w-0">
        {selected ? (
          <ConsultLoader appointmentId={selected} onNext={next ? () => callNext.mutate() : undefined} />
        ) : (
          <Card className="grid min-h-64 place-items-center p-8 text-center text-ink-2">
            <div>
              <p className="font-medium">No patient open</p>
              <p className="text-sm text-ink-3">Press Alt+N to call the next patient, or pick one from the list.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function ConsultLoader({ appointmentId, onNext }: { appointmentId: string; onNext?: () => void }) {
  const view = useQuery({ queryKey: ["consult", appointmentId], queryFn: () => api.consult(appointmentId) });
  if (view.error) return <Alert tone="danger">{view.error.message}</Alert>;
  if (!view.data) return <p className="p-4 text-sm text-ink-3">Loading…</p>;
  const e = view.data.encounter;
  // A new form when the record is signed or opened for correction; typing never remounts it.
  // (A draft created by a nurse's vitals save is still the same draft, so "new" and DRAFT share a key.)
  return <ConsultForm key={`${appointmentId}:${e?.status === "SIGNED" ? "signed" : "draft"}:${e?.version ?? 0}`} view={view.data} onNext={onNext} />;
}
