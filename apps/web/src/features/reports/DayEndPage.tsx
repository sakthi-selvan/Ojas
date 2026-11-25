import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { CASH_SOURCE_LABEL, formatINR, type DayReport, type PaymentMode } from "@ojas/shared";
import { api, dateLabel, timeLabel, today } from "../../lib/api";
import { usePrintJob } from "../../lib/print";
import { Alert, Button, Card, Field } from "../../components/ui";

const MODES: PaymentMode[] = ["CASH", "UPI", "CARD"];
const MODE_LABEL = { CASH: "Cash", UPI: "UPI", CARD: "Card" } as const;

const net = (r: { received: number; refunded: number }) => r.received - r.refunded;
const byMode = (d: DayReport, mode: PaymentMode) =>
  d.rows.filter((r) => r.mode === mode).reduce((s, r) => ({ received: s.received + r.received, refunded: s.refunded + r.refunded }), { received: 0, refunded: 0 });

/**
 * End of day: what every counter took and gave back, by payment mode, and what each person should
 * hand over. Cash in the drawer should match the "Cash" net. Bills put on an in-patient's account
 * are shown apart: no money changed hands for them today.
 */
export function DayEndPage() {
  const [date, setDate] = useState(today());
  const report = useQuery({ queryKey: ["day-report", date], queryFn: () => api.dayReport(date) });
  const { print, view } = usePrintJob<DayReport>((d) => <div className="print-area print-report print-only font-sans text-[10pt] text-black"><Report d={d} /></div>, () => "A4");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-bold">Day-end collections</h1>
        <Field label="Date" type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <Button onClick={() => report.data && print(report.data)} disabled={!report.data}><Printer aria-hidden className="size-4" /> Print</Button>
      </div>
      {report.error && <Alert tone="danger">{report.error.message}</Alert>}
      {report.data && <Card className="p-4 sm:p-6"><Report d={report.data} /></Card>}
      {view}
    </div>
  );
}

function Report({ d }: { d: DayReport }) {
  const total = MODES.reduce((s, m) => s + net(byMode(d, m)), 0);
  const empty = !d.rows.length && !d.onIpBills.length;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-ink-2 print:text-black">{dateLabel(d.date)}{empty ? ": nothing collected." : ""}</p>
      <section aria-labelledby="de-modes">
        <h2 id="de-modes" className="sr-only">By payment mode</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          {MODES.map((m) => {
            const x = byMode(d, m);
            return (
              <div key={m} className="rounded-lg border border-line p-3">
                <div className="text-sm text-ink-2">{m === "CASH" ? "Cash in drawer" : MODE_LABEL[m]}</div>
                <div className="text-2xl font-bold tabular-nums">{formatINR(net(x))}</div>
                {x.refunded > 0 && <div className="text-xs text-ink-3">{formatINR(x.received)} in − {formatINR(x.refunded)} refunded</div>}
              </div>
            );
          })}
          <div className="rounded-lg border border-accent/40 bg-accent-soft/40 p-3">
            <div className="text-sm text-ink-2">Total collected</div>
            <div className="text-2xl font-bold tabular-nums">{formatINR(total)}</div>
          </div>
        </div>
      </section>

      {d.rows.length > 0 && (
        <Table caption="By counter" head={["Counter", "Mode", "Bills", "Received", "Refunded", "Net"]}
          rows={d.rows.map((r) => [CASH_SOURCE_LABEL[r.source], MODE_LABEL[r.mode], String(r.count), formatINR(r.received), r.refunded ? formatINR(r.refunded) : "—", formatINR(net(r))])} />
      )}
      {d.byUser.length > 0 && (
        <Table caption="Handover by person" head={["Person", "Mode", "Received", "Refunded", "To hand over"]}
          rows={d.byUser.map((u) => [u.name, MODE_LABEL[u.mode], formatINR(u.received), u.refunded ? formatINR(u.refunded) : "—", formatINR(net(u))])} />
      )}
      {d.onIpBills.length > 0 && (
        <Table caption="Put on in-patient bills (collected at discharge, not today)" head={["Counter", "Bills", "Amount"]}
          rows={d.onIpBills.map((r) => [CASH_SOURCE_LABEL[r.source], String(r.count), formatINR(r.amount)])} />
      )}
      {d.discounts.length > 0 && (
        <Table caption="Discounts given" head={["Counter", "Bills", "Amount"]}
          rows={d.discounts.map((r) => [CASH_SOURCE_LABEL[r.source], String(r.count), formatINR(r.amount)])} />
      )}
      {d.cancellations.length > 0 && (
        <Table caption="Cancelled OPD bills" head={["Bill", "Patient", "Refunded", "Reason", "By"]}
          rows={d.cancellations.map((c) => [c.billNo, c.patient, formatINR(c.amount), c.reason, `${c.by}, ${timeLabel(c.at)}`])} />
      )}
    </div>
  );
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-1 text-left font-semibold">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            {head.map((h, i) => <th key={h} scope="col" className={i >= head.length - 3 && i > 1 ? "py-1.5 text-right font-medium" : "py-1.5 pr-3 font-medium"}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line">
              {r.map((c, j) => <td key={j} className={j >= head.length - 3 && j > 1 ? "py-1.5 text-right tabular-nums" : "py-1.5 pr-3"}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
