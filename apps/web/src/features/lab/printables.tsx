/**
 * What the lab prints: tube labels (50 × 25 mm label printer), the lab bill (80 mm receipt) and
 * the A4 report. Each is rendered only while printing, so only one ever reaches the printer.
 */
import { Fragment, useEffect, useState } from "react";
import { FLAG_LABEL, LAB_SECTION_LABEL, SAMPLE_SHORT, ageLabel, formatINR, type LabOrderDetail, type LabSection, type OrderTest } from "@ojas/shared";
import { dateTimeLabel } from "../../lib/api";
import { Barcode } from "./barcode";

export type PrintJob =
  | { kind: "labels"; order: LabOrderDetail; sampleIds?: string[] }
  | { kind: "bill"; order: LabOrderDetail }
  | { kind: "report"; order: LabOrderDetail };

const PAGE: Record<PrintJob["kind"], string> = {
  labels: "@page { size: 50mm 25mm; margin: 0; }",
  bill: "@page { size: 80mm auto; margin: 4mm; }",
  report: "@page { size: A4 portrait; margin: 12mm; }",
};
// Labels and the receipt go straight to their own printer in the desktop app; the report asks which printer.
const SILENT: Record<PrintJob["kind"], boolean> = { labels: true, bill: true, report: false };

/** Renders the job, prints it, then removes it. */
export function usePrint() {
  const [job, setJob] = useState<PrintJob | null>(null);
  useEffect(() => {
    if (!job) return;
    const style = document.createElement("style");
    style.textContent = `@media print { ${PAGE[job.kind]} }`;
    document.head.append(style);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      style.remove();
      setJob(null);
    };
    // Let React paint the printable first.
    const t = setTimeout(() => {
      if (window.ojas) void window.ojas.print({ silent: SILENT[job.kind] }).finally(finish);
      else { window.print(); finish(); }
    }, 50);
    return () => clearTimeout(t);
  }, [job]);
  const view = !job ? null
    : job.kind === "labels" ? <PrintableLabels order={job.order} sampleIds={job.sampleIds} />
    : job.kind === "bill" ? <PrintableLabBill order={job.order} />
    : <PrintableLabReport order={job.order} />;
  return { print: setJob, view };
}

const ageSex = (o: LabOrderDetail) => `${o.patient.dob ? ageLabel(o.patient.dob) : "—"} / ${o.patient.sex}`;

function PrintableLabels({ order, sampleIds }: { order: LabOrderDetail; sampleIds?: string[] }) {
  const samples = order.samples.filter((s) => !s.rejectedAt && (!sampleIds || sampleIds.includes(s.id)));
  return (
    <div className="print-area print-labels print-only text-black">
      {samples.map((s) => (
        <div key={s.id} className="lab-label flex flex-col justify-between font-sans text-[8pt] leading-tight">
          <div className="flex justify-between gap-1 font-bold"><span className="truncate">{order.patient.name}</span><span>{ageSex(order)}</span></div>
          <div className="flex justify-between gap-1"><span>{order.patient.uhid}</span><span>{SAMPLE_SHORT[s.sampleType]}</span></div>
          <Barcode value={s.accessionNo} height={22} module={0.9} />
          <div className="flex justify-between gap-1">
            <span className="font-bold">{s.accessionNo}</span>
            <span className="truncate">{order.tests.filter((t) => t.accessionNo === s.accessionNo).map((t) => t.code).join(" ")}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const modeLabel = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

function PrintableLabBill({ order: o }: { order: LabOrderDetail }) {
  return (
    <div className="print-area print-only font-mono text-[11px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{o.facility.name}</div>
        <div>{o.facility.address}</div>
        {o.facility.phone && <div>Ph: {o.facility.phone}</div>}
        <div className="mt-1 font-bold">LABORATORY BILL</div>
      </div>
      <hr className="my-1 border-dashed border-black" />
      <div>Bill: {o.orderNo}</div>
      <div>Date: {dateTimeLabel(o.orderedAt)}</div>
      <div>Name: {o.patient.name} ({o.patient.uhid})</div>
      <div>Age/Sex: {ageSex(o)}</div>
      {o.referredBy && <div>Ref. by: {o.referredBy}</div>}
      <hr className="my-1 border-dashed border-black" />
      {o.tests.map((t) => (
        <div key={t.id} className="flex justify-between gap-2"><span>{t.name}</span><span>{formatINR(t.price)}</span></div>
      ))}
      <hr className="my-1 border-dashed border-black" />
      {o.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>−{formatINR(o.discount)}</span></div>}
      <div className="flex justify-between font-bold"><span>PAID ({modeLabel[o.paymentMode]})</span><span>{formatINR(o.total)}</span></div>
      <div className="mt-1">Reports from {dateTimeLabel(o.tests.reduce((m, t) => (t.dueAt > m ? t.dueAt : m), o.orderedAt))}. Billed by {o.billedBy}.</div>
    </div>
  );
}

/** The A4 report: verified results only, grouped by section, with flags, units and the patient's own reference ranges. */
export function PrintableLabReport({ order: o }: { order: LabOrderDetail }) {
  const verified = o.tests.filter((t) => t.status === "VERIFIED");
  const pending = o.tests.length - verified.length;
  const sections = [...new Set(verified.map((t) => t.section))] as LabSection[];
  const signers = [...new Set(verified.map((t) => t.verifiedBy).filter(Boolean))] as string[];
  const collected = (t: OrderTest) => o.samples.find((s) => s.accessionNo === t.accessionNo)?.collectedAt;
  return (
    <div className="print-area print-report print-only font-sans text-[10.5pt] leading-snug text-black">
      <header className="border-b-2 border-black pb-2 text-center">
        <div className="text-[16pt] font-bold">{o.facility.name}</div>
        <div>{o.facility.address}{o.facility.phone ? ` · Ph: ${o.facility.phone}` : ""}</div>
        <div className="mt-1 text-[12pt] font-bold tracking-wide">LABORATORY REPORT</div>
      </header>
      <table className="my-2 w-full text-[10pt]">
        <tbody>
          <tr><td className="w-1/2">Name: <b>{o.patient.name}</b></td><td>Bill no: {o.orderNo}</td></tr>
          <tr><td>Age / Sex: {ageSex(o)} · ID: {o.patient.uhid}</td><td>Billed: {dateTimeLabel(o.orderedAt)}</td></tr>
          <tr><td>Referred by: {o.referredBy || "Self"}</td><td>Reported: {dateTimeLabel(verified.reduce((m, t) => (t.verifiedAt! > m ? t.verifiedAt! : m), ""))}</td></tr>
        </tbody>
      </table>
      {sections.map((sec) => (
        <section key={sec} className="mt-3 break-inside-avoid-page">
          <h2 className="border-y border-black py-0.5 text-center text-[11pt] font-bold uppercase">{LAB_SECTION_LABEL[sec]}</h2>
          {verified.filter((t) => t.section === sec).map((t) => (
            <div key={t.id} className="mt-2 break-inside-avoid">
              <div className="flex justify-between font-bold">
                <span>{t.name}</span>
                <span className="text-[9pt] font-normal">Sample: {t.accessionNo}{collected(t) ? `, taken ${dateTimeLabel(collected(t)!)}` : ""}{t.method ? ` · ${t.method}` : ""}</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-black text-left text-[9pt]">
                    <th className="w-[38%] font-semibold">Test</th><th className="w-[20%] font-semibold">Result</th><th className="w-[14%] font-semibold">Unit</th><th className="font-semibold">Reference range</th>
                  </tr>
                </thead>
                <tbody>
                  {t.parameters.map((p, i) => {
                    const r = t.results.find((x) => x.paramId === p.id);
                    if (!r) return null;
                    const newGroup = p.group && p.group !== t.parameters[i - 1]?.group;
                    return (
                      <Fragment key={p.id}>
                        {newGroup && <tr><td colSpan={4} className="pt-1 text-[9.5pt] font-semibold italic">{p.group}</td></tr>}
                        <tr>
                          <td className={p.group ? "pl-3" : undefined}>{p.name}</td>
                          <td className={r.flag ? "font-bold" : undefined}>{r.value}{r.flag ? ` ${r.flag === "A" ? "*" : r.flag}` : ""}</td>
                          <td>{p.unit}</td>
                          <td className="text-[9.5pt]">{r.refText}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {t.remarks && <p className="mt-1 text-[9.5pt]"><b>Remarks:</b> {t.remarks}</p>}
              {t.notes && <p className="mt-1 text-[9pt] italic">{t.notes}</p>}
              {t.amendReason && <p className="mt-1 text-[9pt]">Amended report. Reason: {t.amendReason}</p>}
            </div>
          ))}
        </section>
      ))}
      <div className="mt-3 text-[8.5pt]">
        {Object.entries(FLAG_LABEL).map(([k, v]) => `${k === "A" ? "*" : k} = ${v}`).join(" · ")}
        {pending > 0 && <div className="mt-1 font-bold">Partial report: {pending} test{pending === 1 ? "" : "s"} still in progress.</div>}
      </div>
      <footer className="mt-10 flex justify-between text-[10pt]">
        <span className="text-[8.5pt]">Results relate only to the sample tested. Please correlate clinically.</span>
        <span className="text-right">{signers.join(", ")}<br /><span className="text-[9pt]">Verified by</span></span>
      </footer>
    </div>
  );
}
