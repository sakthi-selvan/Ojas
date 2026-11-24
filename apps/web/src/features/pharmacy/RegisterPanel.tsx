import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { api, dateLabel, dateTimeLabel, today } from "../../lib/api";
import { Alert, Button, Card, Field, Select } from "../../components/ui";

const SCOPES = { "H1,X": "Schedule H1 and X (register required)", "H,H1,X": "All scheduled medicines (H, H1, X)" } as const;

/** The Schedule H1 / X register: who got which scheduled medicine, on whose prescription. Printable for inspection. */
export function RegisterPanel() {
  const [from, setFrom] = useState(() => today().slice(0, 8) + "01");
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState<keyof typeof SCOPES>("H1,X");
  const rows = useQuery({ queryKey: ["pharmacy-register", from, to, scope], queryFn: () => api.register(from, to, scope) });
  const print = () => {
    const style = document.createElement("style");
    style.textContent = "@media print { @page { size: A4 landscape; margin: 10mm; } .print-area.print-register { width: 100%; } }";
    document.head.append(style);
    const done = () => style.remove();
    if (window.ojas) void window.ojas.print({ silent: false }).finally(done);
    else { window.print(); done(); }
  };
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} />
        <Select label="Medicines" value={scope} onChange={(e) => setScope(e.target.value as keyof typeof SCOPES)}>
          {Object.entries(SCOPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Button className="ml-auto" onClick={print} disabled={!rows.data?.length}><Printer aria-hidden className="size-4" /> Print register</Button>
      </div>
      {rows.error && <Alert tone="danger">{rows.error.message}</Alert>}
      {rows.data?.length === 0 && <p className="text-sm text-ink-3">No scheduled medicines sold in this period.</p>}
      {!!rows.data?.length && (
        <div className="print-area print-register overflow-x-auto">
          <h2 className="hidden text-base font-bold print:block">Register of {SCOPES[scope]}: {dateLabel(from)} to {dateLabel(to)}</h2>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-ink-3">
              {["Date & time", "Bill", "Patient", "Prescriber", "Medicine", "Sch.", "Batch", "Qty"].map((h) => <th key={h} scope="col" className="p-2 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.data.map((r, i) => (
                <tr key={i} className="border-b border-line">
                  <td className="p-2 whitespace-nowrap">{dateTimeLabel(r.issuedAt)}</td>
                  <td className="p-2 whitespace-nowrap">{r.billNo}</td>
                  <td className="p-2">{r.customerName}{r.customerPhone && <div className="text-xs text-ink-3">{r.customerPhone}</div>}</td>
                  <td className="p-2">{r.prescriber}</td>
                  <td className="p-2 font-medium">{r.itemName}</td>
                  <td className="p-2">{r.schedule}</td>
                  <td className="p-2">{r.batchNo}</td>
                  <td className="p-2 text-right tabular-nums">{r.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
