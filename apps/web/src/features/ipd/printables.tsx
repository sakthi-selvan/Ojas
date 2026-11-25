/**
 * What the in-patient desk prints: a receipt for each payment (80 mm), the discharge summary and
 * the final bill (A4).
 */
import {
  CHARGE_CATEGORY_LABEL, DISCHARGE_TYPE_LABEL, ageLabel, formatINR,
  type Admission, type BillLine, type IpdPayment,
} from "@ojas/shared";
import { dateLabel, dateTimeLabel } from "../../lib/api";
import { usePrintJob } from "../../lib/print";
import { medLine } from "../consult/Prescription";

export type IpdPrintJob =
  | { kind: "receipt"; admission: Admission; payment: IpdPayment }
  | { kind: "summary"; admission: Admission }
  | { kind: "bill"; admission: Admission };

export function useIpdPrint() {
  return usePrintJob<IpdPrintJob>(
    (job) => job.kind === "receipt" ? <PrintableReceipt a={job.admission} p={job.payment} />
      : job.kind === "summary" ? <PrintableSummary a={job.admission} />
      : <PrintableBill a={job.admission} />,
    (job) => (job.kind === "receipt" ? "receipt" : "A4"),
  );
}

const modeLabel = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;
const sexLabel = { M: "Male", F: "Female", O: "Other" } as const;
const lastStay = (a: Admission) => a.stays.at(-1);
const wardBed = (a: Admission) => {
  const s = lastStay(a);
  return s ? `${s.wardName}, bed ${s.bedLabel}` : "—";
};

function PrintableReceipt({ a, p }: { a: Admission; p: IpdPayment }) {
  const title = p.kind === "DEPOSIT" ? "ADVANCE RECEIPT" : p.kind === "REFUND" ? "REFUND VOUCHER" : "PAYMENT RECEIPT";
  return (
    <div className="print-area print-only font-mono text-[11px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{a.facility.name}</div>
        <div>{a.facility.address}</div>
        {a.facility.phone && <div>Ph: {a.facility.phone}</div>}
        <div className="mt-1 font-bold">{title}</div>
      </div>
      <div className="my-1 border-t border-dashed border-black" />
      <div>Receipt: {p.receiptNo}</div>
      <div>Date: {dateTimeLabel(p.at)}</div>
      <div>Patient: {a.patient.name} ({a.patient.uhid})</div>
      <div>IP no: {a.admissionNo}</div>
      <div>Ward: {wardBed(a)}</div>
      <div className="my-1 border-t border-dashed border-black" />
      <div className="flex justify-between text-[13px] font-bold">
        <span>{p.kind === "REFUND" ? "Refunded" : "Received"}</span><span>{formatINR(p.amount)}</span>
      </div>
      <div>Mode: {modeLabel[p.mode]}</div>
      <div className="my-1 border-t border-dashed border-black" />
      <div>{p.kind === "REFUND" ? "Paid by" : "Received by"}: {p.by}</div>
      {p.kind === "DEPOSIT" && <div className="mt-1">Advance is adjusted against the final bill.</div>}
      <div className="mt-6">Signature: ____________</div>
    </div>
  );
}

function Header({ a, title }: { a: Admission; title: string }) {
  return (
    <>
      <header className="border-b-2 border-black pb-2 text-center">
        <div className="text-[16pt] font-bold">{a.facility.name}</div>
        <div>{a.facility.address}{a.facility.phone ? ` · Ph: ${a.facility.phone}` : ""}{a.facility.email ? ` · ${a.facility.email}` : ""}</div>
        <div className="mt-1 text-[12pt] font-bold tracking-wide">{title}</div>
      </header>
      <table className="my-2 w-full text-[10pt]">
        <tbody>
          <tr><td className="w-1/2">Name: <b>{a.patient.name}</b></td><td>IP no: {a.admissionNo}</td></tr>
          <tr><td>Age / Sex: {a.patient.dob ? ageLabel(a.patient.dob) : "—"} / {sexLabel[a.patient.sex]} · ID: {a.patient.uhid}</td><td>Admitted: {dateTimeLabel(a.admittedAt)}</td></tr>
          <tr><td>Doctor: {a.doctor.name}{a.doctor.department ? ` (${a.doctor.department})` : ""}</td><td>{a.dischargedAt ? `Discharged: ${dateTimeLabel(a.dischargedAt)}` : "Still admitted"}</td></tr>
          <tr><td>Ward: {wardBed(a)}</td><td>Phone: {a.patient.phone}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  if (!children || (typeof children === "string" && !children.trim())) return null;
  return (
    <section className="mt-3 break-inside-avoid">
      <h2 className="border-b border-black text-[10.5pt] font-bold uppercase">{title}</h2>
      <div className="mt-1 whitespace-pre-wrap">{children}</div>
    </section>
  );
}

/** The discharge summary, as the doctor signed it. */
function PrintableSummary({ a }: { a: Admission }) {
  const s = a.summary;
  if (!s) return null;
  const title = s.dischargeType === "DEATH" ? "DEATH SUMMARY" : s.dischargeType === "LAMA" ? "DISCHARGE SUMMARY (LAMA)" : "DISCHARGE SUMMARY";
  return (
    <div className="print-area print-report print-only font-sans text-[10.5pt] leading-snug text-black">
      <Header a={a} title={title} />
      {s.dischargeType !== "NORMAL" && <p className="font-bold">{DISCHARGE_TYPE_LABEL[s.dischargeType]}</p>}
      <Block title="Reason for admission">{a.reason}</Block>
      <Block title="Final diagnosis">
        {s.diagnoses.length > 0 && <ol className="list-decimal pl-5">{s.diagnoses.map((d, i) => <li key={i}>{d.text}{d.code ? ` (${d.code})` : ""}</li>)}</ol>}
      </Block>
      <Block title="Presenting complaints">{s.presentingComplaints}</Block>
      <Block title="Course in hospital">{s.courseInHospital}</Block>
      <Block title="Investigations">{s.investigations}</Block>
      <Block title="Treatment given">{s.treatmentGiven}</Block>
      <Block title="Condition at discharge">{s.conditionAtDischarge}</Block>
      <Block title="Medicines to continue">
        {s.medications.length > 0 && <ol className="list-decimal pl-5">{s.medications.map((m, i) => <li key={i}><b>{m.drug}</b> · {medLine(m)}{m.instructions ? ` · ${m.instructions}` : ""}</li>)}</ol>}
      </Block>
      <Block title="Advice">{s.advice}</Block>
      {s.followUpDate && <p className="mt-3"><b>Review on:</b> {dateLabel(s.followUpDate)}</p>}
      {s.dischargeType !== "DEATH" && <p className="mt-3 text-[9.5pt]">In an emergency, or if the symptoms come back, come to the hospital at once.</p>}
      <footer className="mt-12 flex justify-between text-[10pt]">
        <span>{a.summarySignedAt ? `Signed ${dateTimeLabel(a.summarySignedAt)}` : "Not signed"}</span>
        <span className="text-right">
          <b>{a.doctor.name}</b>{a.doctor.qualification ? `, ${a.doctor.qualification}` : ""}<br />
          {a.doctor.registrationNo && <span className="text-[9pt]">Reg. no {a.doctor.registrationNo}<br /></span>}
          <span className="text-[9pt]">Treating doctor</span>
        </span>
      </footer>
    </div>
  );
}

/** The final (or, before discharge, interim) bill: room by the night, then itemised charges, then payments. */
function PrintableBill({ a }: { a: Admission }) {
  const b = a.bill;
  const groups = [...new Set(b.lines.map((l) => l.category))];
  const final = a.status === "DISCHARGED";
  return (
    <div className="print-area print-report print-only font-sans text-[10.5pt] leading-snug text-black">
      <Header a={a} title={final ? `FINAL BILL · ${a.finalBillNo}` : "INTERIM BILL (NOT FINAL)"} />
      <table className="w-full">
        <thead>
          <tr className="border-y border-black text-left text-[9.5pt]">
            <th className="font-semibold">Particulars</th><th className="w-16 text-right font-semibold">Qty</th>
            <th className="w-24 text-right font-semibold">Rate</th><th className="w-28 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g} title={CHARGE_CATEGORY_LABEL[g]} lines={b.lines.filter((l) => l.category === g)} />
          ))}
        </tbody>
        <tfoot className="text-right">
          <tr className="border-t border-black"><td colSpan={3}>Total</td><td className="tabular-nums">{formatINR(b.subtotal)}</td></tr>
          {b.discount > 0 && <tr><td colSpan={3}>Discount</td><td className="tabular-nums">− {formatINR(b.discount)}</td></tr>}
          {b.discount > 0 && <tr className="font-bold"><td colSpan={3}>Net amount</td><td className="tabular-nums">{formatINR(b.total)}</td></tr>}
        </tfoot>
      </table>
      <h2 className="mt-4 border-b border-black text-[10.5pt] font-bold uppercase">Payments</h2>
      <table className="w-full text-[10pt]">
        <tbody>
          {a.payments.map((p) => (
            <tr key={p.id}>
              <td>{p.receiptNo}</td><td>{dateTimeLabel(p.at)}</td>
              <td>{p.kind === "DEPOSIT" ? "Advance" : p.kind === "REFUND" ? "Refund" : "Final payment"} · {modeLabel[p.mode]}</td>
              <td className="text-right tabular-nums">{p.kind === "REFUND" ? "− " : ""}{formatINR(p.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-black font-bold">
            <td colSpan={3} className="text-right">{b.balance > 0 ? "Balance due" : b.balance < 0 ? "To refund" : "Paid in full"}</td>
            <td className="text-right tabular-nums">{b.balance === 0 ? formatINR(b.paid) : formatINR(Math.abs(b.balance))}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-[9pt]">Room and nursing are charged per night (the bed occupied at midnight); a stay without a night counts as one day. Days: {b.days}.</p>
      <footer className="mt-12 flex justify-between text-[10pt]">
        <span>Patient / attendant</span>
        <span>For {a.facility.name}</span>
      </footer>
    </div>
  );
}

function GroupRows({ title, lines }: { title: string; lines: BillLine[] }) {
  return (
    <>
      <tr><td colSpan={4} className="pt-1.5 text-[9.5pt] font-semibold italic">{title}</td></tr>
      {lines.map((l, i) => (
        <tr key={i}>
          <td className="pl-3">{l.description}</td>
          <td className="text-right tabular-nums">{l.quantity}</td>
          <td className="text-right tabular-nums">{formatINR(l.unitPrice)}</td>
          <td className="text-right tabular-nums">{formatINR(l.amount)}</td>
        </tr>
      ))}
    </>
  );
}
