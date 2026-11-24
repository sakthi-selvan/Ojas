import { useQuery } from "@tanstack/react-query";
import { History, Repeat } from "lucide-react";
import type { Medication } from "@ojas/shared";
import { api, dateLabel } from "../../lib/api";
import { Alert, Button, Card } from "../../components/ui";
import { medLine } from "./Prescription";

/** The patient's earlier signed visits beside the form; "Repeat medicines" copies a past prescription in. */
export function PastVisits({ appointmentId, onRepeat }: { appointmentId: string; onRepeat?: (meds: Medication[]) => void }) {
  const history = useQuery({ queryKey: ["consult-history", appointmentId], queryFn: () => api.consultHistory(appointmentId) });
  return (
    <Card className="flex flex-col" aria-labelledby={`hist-${appointmentId}`}>
      <h2 id={`hist-${appointmentId}`} className="flex items-center gap-2 border-b border-line p-4 font-semibold">
        <History aria-hidden className="size-4" /> Earlier visits
      </h2>
      {history.error && <div className="p-3"><Alert tone="danger">{history.error.message}</Alert></div>}
      {history.data?.length === 0 && <p className="p-4 text-sm text-ink-3">First visit: no earlier consultations here.</p>}
      <ol className="flex flex-col divide-y divide-line">
        {history.data?.map((v) => (
          <li key={v.appointmentId} className="flex flex-col gap-1.5 p-4 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{dateLabel(v.date)}</span>
              <span className="truncate text-ink-3">{v.practitionerName}</span>
            </div>
            {v.chiefComplaint && <p className="text-ink-2">{v.chiefComplaint}</p>}
            {v.diagnoses.length > 0 && <p><span className="text-ink-3">Dx:</span> {v.diagnoses.map((d) => d.text).join("; ")}</p>}
            {(v.vitals.bpSystolic != null || v.vitals.weightKg != null) && (
              <p className="text-ink-2">
                {v.vitals.bpSystolic != null && `BP ${v.vitals.bpSystolic}/${v.vitals.bpDiastolic ?? "–"}`}
                {v.vitals.bpSystolic != null && v.vitals.weightKg != null && " · "}
                {v.vitals.weightKg != null && `Wt ${v.vitals.weightKg} kg`}
              </p>
            )}
            {v.medications.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {v.medications.map((m, i) => <li key={i}><strong>{m.drug}</strong> <span className="text-ink-2">{medLine(m)}</span></li>)}
              </ul>
            )}
            {v.labOrders.length > 0 && <p><span className="text-ink-3">Tests:</span> {v.labOrders.map((l) => l.test).join(", ")}</p>}
            {onRepeat && v.medications.length > 0 && (
              <Button variant="ghost" className="self-start" onClick={() => onRepeat(v.medications)}>
                <Repeat aria-hidden className="size-4" /> Repeat medicines
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
