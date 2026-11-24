import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueueItem } from "@ojas/shared";
import { api } from "../../lib/api";
import { Alert } from "../../components/ui";
import { VitalsForm } from "./VitalsForm";

/** Nurse at triage: record vitals for a patient from the OPD queue. Closes after saving. */
export function VitalsDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const view = useQuery({ queryKey: ["consult", item.appointmentId], queryFn: () => api.consult(item.appointmentId) });
  // No close() in a cleanup: closing fires onClose, which would unmount the dialog straight after
  // React's development double-mount. Unmounting removes the dialog anyway.
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  const signed = view.data?.encounter?.status === "SIGNED";
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={`vd-${item.appointmentId}`} className="m-auto w-full max-w-3xl rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/50">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 place-items-center rounded-lg bg-surface-2 text-lg font-bold tabular-nums">{item.token}</div>
        <div>
          <h2 id={`vd-${item.appointmentId}`} className="text-lg font-bold">Vitals: {item.patientName}</h2>
          <p className="text-sm text-ink-2">{item.uhid} · {item.practitionerName}</p>
        </div>
        <button type="button" className="ml-auto rounded-md px-2 text-ink-2 hover:bg-surface-2" onClick={() => ref.current?.close()} aria-label="Close">✕</button>
      </div>
      {view.error && <Alert tone="danger">{view.error.message}</Alert>}
      {signed && <div className="mb-3"><Alert tone="warn">The doctor has signed this visit, so vitals can no longer be changed here.</Alert></div>}
      {view.data && (
        <VitalsForm appointmentId={item.appointmentId} encounter={view.data.encounter} readOnly={signed} autoFocus onSaved={() => setTimeout(() => ref.current?.close(), 400)} />
      )}
    </dialog>
  );
}
