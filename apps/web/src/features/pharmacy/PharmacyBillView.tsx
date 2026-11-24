import { CheckCircle2, Printer } from "lucide-react";
import { expiryLabel, formatINR, type PharmacyBill } from "@ojas/shared";
import { dateTimeLabel } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Button } from "../../components/ui";

const modeLabel = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

/** Desktop app: silent print to the default (receipt) printer. Browser: the print dialog. */
export const printBill = () => (window.ojas ? void window.ojas.print({ silent: true }) : window.print());

export function PharmacyBillView({ bill, onNext }: { bill: PharmacyBill; onNext: () => void }) {
  useHotkeys({ P: printBill, Enter: onNext, Escape: onNext });
  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex items-center gap-4 rounded-xl bg-ok-soft p-4 text-ok">
        <CheckCircle2 aria-hidden className="size-8 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold">Paid {formatINR(bill.total)} by {modeLabel[bill.paymentMode]} · {bill.billNo}</div>
          <div className="text-sm">{bill.customerName} · {bill.lines.length} line{bill.lines.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="lg" onClick={onNext} shortcut="Enter" autoFocus>Next customer</Button>
        <Button size="lg" onClick={printBill} shortcut="P"><Printer aria-hidden className="size-4" /> Print bill</Button>
      </div>
      <PrintablePharmacyBill bill={bill} />
    </div>
  );
}

/** 80 mm pharmacy bill: drug licence and GSTIN, batch and expiry per medicine, GST by rate. Prints only. */
export function PrintablePharmacyBill({ bill: b }: { bill: PharmacyBill }) {
  return (
    <div className="print-area print-only font-mono text-[11px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{b.facility.name}</div>
        <div>{b.facility.address}</div>
        {b.facility.phone && <div>Ph: {b.facility.phone}</div>}
        {b.facility.gstin && <div>GSTIN: {b.facility.gstin}</div>}
        {b.facility.drugLicence && <div>DL No: {b.facility.drugLicence}</div>}
        <div className="mt-1 font-bold">TAX INVOICE</div>
      </div>
      <hr className="my-1 border-dashed border-black" />
      <div>Bill: {b.billNo}</div>
      <div>Date: {dateTimeLabel(b.issuedAt)}</div>
      <div>Name: {b.customerName}{b.uhid ? ` (${b.uhid})` : ""}</div>
      {b.customerPhone && <div>Ph: {b.customerPhone}</div>}
      {b.prescriber && <div>Prescribed by: {b.prescriber}</div>}
      <hr className="my-1 border-dashed border-black" />
      {b.lines.map((l, i) => (
        <div key={i} className="mb-1">
          <div className="flex justify-between gap-2">
            <span className="font-bold">{l.itemName}{l.schedule !== "NONE" ? ` [${l.schedule}]` : ""}</span>
            <span>{formatINR(l.amount)}</span>
          </div>
          <div>
            {l.qty} × {formatINR(Math.round(l.mrpPerPack / l.packSize * 100) / 100)} · B:{l.batchNo} · Exp:{expiryLabel(l.expiry)} · GST {l.gstRate}%
          </div>
        </div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      <div className="flex justify-between"><span>Total (MRP)</span><span>{formatINR(b.subtotal)}</span></div>
      {b.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>-{formatINR(b.discount)}</span></div>}
      <div className="flex justify-between text-[13px] font-bold"><span>NET ({modeLabel[b.paymentMode]})</span><span>{formatINR(b.total)}</span></div>
      <hr className="my-1 border-dashed border-black" />
      <table className="w-full">
        <thead><tr><th className="text-left font-normal">GST%</th><th className="text-right font-normal">Taxable</th><th className="text-right font-normal">CGST</th><th className="text-right font-normal">SGST</th></tr></thead>
        <tbody>
          {b.gst.map((g) => (
            <tr key={g.rate}><td>{g.rate}</td><td className="text-right">{formatINR(g.taxable)}</td><td className="text-right">{formatINR(g.cgst)}</td><td className="text-right">{formatINR(g.sgst)}</td></tr>
          ))}
        </tbody>
      </table>
      <hr className="my-1 border-dashed border-black" />
      <div className="text-center">Prices include GST. Billed by {b.soldBy}.</div>
      <div className="text-center">Get well soon</div>
    </div>
  );
}
