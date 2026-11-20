import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Banknote, CreditCard, Smartphone } from "lucide-react";
import { formatINR, type PaymentMode, type Practitioner, type Receipt } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { useAuth } from "../../lib/auth";
import { Alert, Button, Field, Segmented } from "../../components/ui";

const LAST_MODE = "ojas.frontdesk.paymentMode";
const savedMode = (): PaymentMode => {
  try {
    const v = localStorage.getItem(LAST_MODE);
    return v === "UPI" || v === "CARD" ? v : "CASH";
  } catch {
    return "CASH";
  }
};

/**
 * Step 3: bill and payment. The bill is filled in automatically. The receptionist only confirms
 * the payment mode (keys 1/2/3) and presses F9.
 */
export function BillStep({
  patientId, doctor, slotStart, onPaid, onSlotTaken,
}: {
  patientId: string;
  doctor: Practitioner;
  slotStart: string;
  onPaid: (r: Receipt) => void;
  onSlotTaken: (message: string) => void;
}) {
  const { can } = useAuth();
  const canDiscount = can("billing.discount");
  const [mode, setMode] = useState<PaymentMode>(savedMode);
  const [discountText, setDiscountText] = useState("");
  // One key per bill attempt: a double-press of F9 or a retry after a timeout can never charge twice.
  const idemKey = useRef(crypto.randomUUID());

  const fee = doctor.consultationFee;
  const discount = canDiscount ? Math.round((Number(discountText.replace(/[^\d.]/g, "")) || 0) * 100) : 0;
  const discountError = discount > fee ? "Discount is more than the bill" : undefined;
  const total = Math.max(0, fee - discount);

  const pay = useMutation({
    mutationFn: () => api.checkout({ patientId, practitionerId: doctor.id, slotStart, discount, paymentMode: mode, idempotencyKey: idemKey.current }),
    onSuccess: (r) => {
      try {
        localStorage.setItem(LAST_MODE, mode);
      } catch { /* ignore */ }
      onPaid(r);
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === "slot_taken" || e.code === "slot_in_past")) onSlotTaken(e.message);
      // A definite rejection means nothing was saved, so the next attempt gets a new key.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });

  const submit = () => {
    if (!discountError && !pay.isPending) pay.mutate();
  };

  useHotkeys({ F9: submit, "1": () => setMode("CASH"), "2": () => setMode("UPI"), "3": () => setMode("CARD") });

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-sm">
        <caption className="sr-only">Bill items</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th scope="col" className="py-2 font-medium">Item</th>
            <th scope="col" className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-line">
            <td className="py-2.5">Consultation: {doctor.name} <span className="text-ink-3">({doctor.department})</span></td>
            <td className="py-2.5 text-right tabular-nums">{formatINR(fee)}</td>
          </tr>
        </tbody>
      </table>

      <div className={canDiscount ? "grid gap-4 sm:grid-cols-[1fr_2fr]" : "grid gap-4"}>
        {canDiscount && <Field label="Discount (₹)" inputMode="decimal" placeholder="0" value={discountText} onChange={(e) => setDiscountText(e.target.value)} error={discountError} />}
        <Segmented
          label="Payment mode"
          name="mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "CASH", label: "Cash", key: "1", icon: <Banknote aria-hidden className="size-4" /> },
            { value: "UPI", label: "UPI", key: "2", icon: <Smartphone aria-hidden className="size-4" /> },
            { value: "CARD", label: "Card", key: "3", icon: <CreditCard aria-hidden className="size-4" /> },
          ]}
        />
      </div>

      {pay.error && !(pay.error instanceof ApiError && pay.error.code === "slot_taken") && <Alert tone="danger">{pay.error.message}</Alert>}

      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-surface-2 p-4">
        <div>
          <div className="text-sm text-ink-2">To collect ({mode === "CASH" ? "cash" : mode === "UPI" ? "UPI" : "card"})</div>
          <div className="text-3xl font-bold tabular-nums" aria-live="polite">{formatINR(total)}</div>
        </div>
        <Button variant="primary" size="lg" className="ml-auto" onClick={submit} disabled={pay.isPending || !!discountError} shortcut="F9" autoFocus>
          {pay.isPending ? "Saving…" : `Collect ${formatINR(total)} & print`}
        </Button>
      </div>
    </div>
  );
}
