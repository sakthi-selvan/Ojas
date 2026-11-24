import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppointmentStatus, QueueItem } from "@ojas/shared";
import { api, timeLabel, today } from "../../lib/api";
import { Activity } from "lucide-react";
import { Alert, Badge, Button, Card, cx } from "../../components/ui";
import { VitalsDialog } from "../consult/VitalsDialog";
import { useAuth } from "../../lib/auth";

export const statusMeta: Record<AppointmentStatus, { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "accent" }> = {
  BOOKED: { label: "Booked", tone: "neutral" },
  CHECKED_IN: { label: "Waiting", tone: "warn" },
  IN_CONSULT: { label: "With doctor", tone: "accent" },
  DONE: { label: "Done", tone: "ok" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};

const nextAction: Partial<Record<AppointmentStatus, { to: AppointmentStatus; label: string }>> = {
  BOOKED: { to: "CHECKED_IN", label: "Check in" },
  CHECKED_IN: { to: "IN_CONSULT", label: "Send in" },
  IN_CONSULT: { to: "DONE", label: "Done" },
};

export function useQueue(date = today()) {
  return useQuery({ queryKey: ["queue", date], queryFn: () => api.queue(date), refetchInterval: 30_000 });
}

/** Today's live queue beside the front desk. It updates instantly when any desk books or any doctor calls a patient. */
export function QueuePanel() {
  const queue = useQueue();
  const [doctor, setDoctor] = useState<string>("all");
  const items = queue.data ?? [];
  const doctors = useMemo(() => [...new Map(items.map((i) => [i.practitionerId, i.practitionerName])).entries()], [items]);
  const shown = doctor === "all" ? items : items.filter((i) => i.practitionerId === doctor);
  const waiting = items.filter((i) => i.status === "BOOKED" || i.status === "CHECKED_IN").length;

  return (
    <Card className="flex max-h-[calc(100vh-7rem)] flex-col lg:sticky lg:top-20" aria-labelledby="queue-h">
      <div className="flex items-center gap-2 border-b border-line p-4">
        <h2 id="queue-h" className="font-semibold">Today's queue</h2>
        <Badge tone="warn">{waiting} waiting</Badge>
        <Badge>{items.length} total</Badge>
      </div>
      {doctors.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2" role="group" aria-label="Filter by doctor">
          {[["all", "All"] as const, ...doctors].map(([id, name]) => (
            <button
              key={id}
              type="button"
              aria-pressed={doctor === id}
              onClick={() => setDoctor(id)}
              className={cx("shrink-0 rounded-full px-3 py-1 text-xs font-medium", doctor === id ? "bg-ink text-surface" : "bg-surface-2 text-ink-2 hover:text-ink")}
            >
              {name.replace(/^Dr\.\s*/, "")}
            </button>
          ))}
        </div>
      )}
      {queue.error && <div className="p-3"><Alert tone="danger">{(queue.error as Error).message}</Alert></div>}
      <ol className="flex-1 overflow-y-auto p-2" aria-label="Appointments">
        {shown.length === 0 && <li className="p-6 text-center text-sm text-ink-3">No appointments yet today.</li>}
        {shown.map((i) => <QueueRow key={i.appointmentId} item={i} />)}
      </ol>
    </Card>
  );
}

export function QueueRow({ item }: { item: QueueItem }) {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (to: AppointmentStatus) => api.setStatus(item.appointmentId, to),
    onSettled: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  });
  const { can } = useAuth();
  const [vitalsOpen, setVitalsOpen] = useState(false);
  const action = can("queue.update") ? nextAction[item.status] : undefined;
  const meta = statusMeta[item.status];
  const vitalsAllowed = can("vitals.write") && item.status !== "CANCELLED" && item.status !== "DONE";
  return (
    <li className={cx("flex items-center gap-3 rounded-lg px-2 py-2", item.status === "DONE" && "opacity-60")}>
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-lg font-bold tabular-nums" aria-label={`Token ${item.token}`}>
        {item.token}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{item.patientName}</div>
        <div className="flex items-center gap-1 truncate text-xs text-ink-2">
          {timeLabel(item.slotStart)} · {item.practitionerName}
          {item.vitalsRecorded && <><span aria-hidden>·</span><Activity aria-hidden className="size-3 text-ok" /><span className="sr-only">Vitals recorded</span></>}
        </div>
      </div>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {vitalsAllowed && (
        <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setVitalsOpen(true)} aria-label={`${item.vitalsRecorded ? "Edit vitals" : "Record vitals"}: ${item.patientName}`}>
          Vitals
        </Button>
      )}
      {vitalsOpen && <VitalsDialog item={item} onClose={() => setVitalsOpen(false)} />}
      {action && (
        <Button variant="ghost" className="min-h-8 px-2 text-xs" disabled={move.isPending} onClick={() => move.mutate(action.to)} aria-label={`${action.label}: ${item.patientName}`}>
          {action.label}
        </Button>
      )}
    </li>
  );
}
