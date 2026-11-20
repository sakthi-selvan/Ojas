import { useEffect } from "react";
import { CheckCircle2, Printer } from "lucide-react";
import { ageLabel, formatINR, type Receipt } from "@ojas/shared";
import { timeLabel } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Button } from "../../components/ui";

const modeLabel = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

declare global {
  interface Window {
    /** Present only inside the Ojas desktop app (see apps/desktop/src/preload.ts). */
    ojas?: { desktop: true; print: (opts?: { silent?: boolean }) => Promise<{ ok: boolean; error?: string }> };
  }
}

/** Desktop app: silent print to the default (thermal) printer. Browser: the normal print dialog. */
const printReceipt = () => (window.ojas ? void window.ojas.print({ silent: true }) : window.print());

/** Success state: the token is what the patient needs, so it is the largest thing on screen. */
export function ReceiptView({ receipt, onNext }: { receipt: Receipt; onNext: () => void }) {
  const print = printReceipt;
  useHotkeys({ P: print, Enter: onNext, Escape: onNext });

  // Auto-print where the desk has opted in (default on in the desktop app, off in a browser).
  useEffect(() => {
    if (shouldAutoPrint()) setTimeout(print, 50);
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div role="status" className="flex items-center gap-4 rounded-xl bg-ok-soft p-4 text-ok">
        <CheckCircle2 aria-hidden className="size-8 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold">Paid {formatINR(receipt.total)} by {modeLabel[receipt.paymentMode]} · {receipt.invoiceNo}</div>
          <div className="text-sm">{receipt.patient.name} is booked with {receipt.practitioner.name} at {timeLabel(receipt.slotStart)}</div>
        </div>
        <div className="text-center">
          <div className="text-xs font-semibold uppercase tracking-wide">Token</div>
          <div className="text-5xl font-bold tabular-nums leading-none">{receipt.token}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="lg" onClick={onNext} shortcut="Enter" autoFocus>
          Next patient
        </Button>
        <Button size="lg" onClick={print} shortcut="P">
          <Printer aria-hidden className="size-4" /> Print receipt
        </Button>
      </div>
      <PrintableReceipt r={receipt} />
    </div>
  );
}

function shouldAutoPrint(): boolean {
  try {
    const v = localStorage.getItem("ojas.autoPrint");
    if (v !== null) return v === "1";
  } catch { /* ignore */ }
  return !!window.ojas; // desktop app: on by default
}

/** Thermal-printer friendly receipt (80 mm). Hidden on screen, the only thing that prints. */
export function PrintableReceipt({ r }: { r: Receipt }) {
  return (
    <div className="print-area print-only font-mono text-[12px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{r.facility.name}</div>
        <div>{r.facility.address}</div>
        <div>Ph: {r.facility.phone}</div>
      </div>
      <hr className="my-1 border-dashed border-black" />
      <div className="text-center">
        <div>TOKEN</div>
        <div className="text-[32px] font-bold leading-none">{r.token}</div>
        <div>{r.practitioner.name} · {r.practitioner.department}</div>
        <div>{new Date(r.slotStart).toLocaleDateString("en-IN")} {timeLabel(r.slotStart)}</div>
      </div>
      <hr className="my-1 border-dashed border-black" />
      <div>Bill: {r.invoiceNo}</div>
      <div>Date: {new Date(r.issuedAt).toLocaleString("en-IN")}</div>
      <div>Patient: {r.patient.name} ({r.patient.sex}/{ageLabel(r.patient.dob)})</div>
      <div>UHID: {r.patient.uhid} · {r.patient.phone}</div>
      <hr className="my-1 border-dashed border-black" />
      {r.lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-2">
          <span>{l.description}</span>
          <span>{formatINR(l.amount)}</span>
        </div>
      ))}
      {r.discount > 0 && (
        <div className="flex justify-between"><span>Discount</span><span>-{formatINR(r.discount)}</span></div>
      )}
      <div className="flex justify-between font-bold"><span>TOTAL ({modeLabel[r.paymentMode]})</span><span>{formatINR(r.total)}</span></div>
      <hr className="my-1 border-dashed border-black" />
      <div className="text-center">Get well soon</div>
    </div>
  );
}
