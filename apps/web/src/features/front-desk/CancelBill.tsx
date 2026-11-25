import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, CreditCard, Smartphone } from "lucide-react";
import { formatINR, type PaymentMode, type QueueItem, type Receipt } from "@ojas/shared";
import { api, ApiError, dateTimeLabel, timeLabel } from "../../lib/api";
import { usePrintJob } from "../../lib/print";
import { Alert, Button, Field, Segmented } from "../../components/ui";

const modeLabel = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

/** Prints the refund voucher once a bill is cancelled (the patient signs it for the money back). */
export function useRefundVoucher() {
  return usePrintJob<Receipt>((r) => <PrintableRefund r={r} />, () => "receipt");
}

/**
 * Cancelling a paid OPD bill before the patient sees the doctor: the visit is cancelled, the slot
 * freed, and the full amount refunded. Needs the refund permission (accounts or an administrator).
 */
export function CancelBillDialog({ item, onClose, onDone }: { item: QueueItem; onClose: () => void; onDone: (r: Receipt) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const bill = useQuery({ queryKey: ["receipt", item.invoiceId], queryFn: () => api.receipt(item.invoiceId!) });
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<PaymentMode | undefined>();
  useEffect(() => {
    if (ref.current && !ref.current.open) {
      ref.current.showModal();
      // showModal focuses the first control (the close button); the reason is what's typed first.
      ref.current.querySelector<HTMLInputElement>("input")?.focus();
    }
  }, []);
  const refundMode = mode ?? bill.data?.paymentMode ?? "CASH";
  const cancel = useMutation({
    mutationFn: () => api.cancelBill(item.invoiceId!, { reason, refundMode }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      onDone(r);
      ref.current?.close();
    },
  });
  const errs = cancel.error instanceof ApiError ? cancel.error.fields : {};
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={`cb-${item.appointmentId}`} className="m-auto w-full max-w-lg rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/50">
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
        <div className="flex items-start gap-3">
          <div>
            <h2 id={`cb-${item.appointmentId}`} className="text-lg font-bold">Cancel visit and refund</h2>
            <p className="text-sm text-ink-2">{item.patientName} · token {item.token} · {item.practitionerName} at {timeLabel(item.slotStart)}</p>
          </div>
          <button type="button" className="ml-auto rounded-md px-2 text-ink-2 hover:bg-surface-2" onClick={() => ref.current?.close()} aria-label="Close">✕</button>
        </div>
        {bill.error && <Alert tone="danger">{bill.error.message}</Alert>}
        {bill.data && (
          <p className="rounded-lg bg-surface-2 p-3 text-sm">
            Bill {bill.data.invoiceNo}: paid <b>{formatINR(bill.data.total)}</b> by {modeLabel[bill.data.paymentMode]} on {dateTimeLabel(bill.data.issuedAt)}.
            The whole amount goes back, and the slot is freed.
          </p>
        )}
        <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={errs.reason} placeholder="Doctor called to an emergency, patient changed their mind…" />
        <Segmented
          label="Refund by"
          name={`refund-${item.appointmentId}`}
          value={refundMode}
          onChange={setMode}
          options={[
            { value: "CASH", label: "Cash", icon: <Banknote aria-hidden className="size-4" /> },
            { value: "UPI", label: "UPI", icon: <Smartphone aria-hidden className="size-4" /> },
            { value: "CARD", label: "Card", icon: <CreditCard aria-hidden className="size-4" /> },
          ]}
        />
        {cancel.error && !Object.keys(errs).length && <Alert tone="danger">{cancel.error.message}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" variant="danger" disabled={!bill.data || reason.trim().length < 5 || cancel.isPending}>
            {cancel.isPending ? "Cancelling…" : `Cancel & refund ${bill.data ? formatINR(bill.data.total) : ""}`}
          </Button>
          <Button onClick={() => ref.current?.close()}>Keep the visit</Button>
        </div>
      </form>
    </dialog>
  );
}

function PrintableRefund({ r }: { r: Receipt }) {
  const c = r.cancelled!;
  return (
    <div className="print-area print-only font-mono text-[12px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{r.facility.name}</div>
        <div>{r.facility.address}</div>
        {r.facility.phone && <div>Ph: {r.facility.phone}</div>}
        <div className="mt-1 font-bold">REFUND VOUCHER</div>
      </div>
      <hr className="my-1 border-dashed border-black" />
      <div>Against bill: {r.invoiceNo}</div>
      <div>Bill date: {new Date(r.issuedAt).toLocaleString("en-IN")}</div>
      <div>Refunded: {new Date(c.at).toLocaleString("en-IN")}</div>
      <div>Patient: {r.patient.name} ({r.patient.uhid})</div>
      <div>Visit: {r.practitioner.name}, token {r.token}</div>
      <div>Reason: {c.reason}</div>
      <hr className="my-1 border-dashed border-black" />
      <div className="flex justify-between text-[13px] font-bold"><span>REFUNDED ({modeLabel[c.refundMode]})</span><span>{formatINR(c.refunded)}</span></div>
      <hr className="my-1 border-dashed border-black" />
      <div>Refunded by: {c.by}</div>
      <div className="mt-6">Received by patient: ____________</div>
    </div>
  );
}
