import { useMemo } from "react";
import type { QueueItem } from "@ojas/shared";
import { Badge, Card } from "../../components/ui";
import { QueueRow, useQueue } from "./QueuePanel";
import { useRefundVoucher } from "../front-desk/CancelBill";

/** Full-screen OPD queue: one column per doctor. Also suitable for a nurse station screen. */
export function QueueBoard() {
  const queue = useQueue();
  const voucher = useRefundVoucher();
  const columns = useMemo(() => {
    const m = new Map<string, { name: string; items: QueueItem[] }>();
    for (const i of queue.data ?? []) {
      const col = m.get(i.practitionerId) ?? { name: i.practitionerName, items: [] };
      col.items.push(i);
      m.set(i.practitionerId, col);
    }
    return [...m.entries()];
  }, [queue.data]);

  return (
    <div className="mx-auto max-w-[1600px] p-4 lg:p-6">
      <h1 className="mb-4 text-xl font-bold">OPD queue: today</h1>
      {voucher.view}
      {columns.length === 0 && !queue.isLoading && <p className="text-ink-3">No appointments yet today. Bookings from the front desk appear here instantly.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {columns.map(([id, col]) => {
          const current = col.items.find((i) => i.status === "IN_CONSULT");
          const waiting = col.items.filter((i) => i.status === "BOOKED" || i.status === "CHECKED_IN").length;
          return (
            <Card key={id} aria-label={col.name}>
              <div className="flex items-center gap-2 border-b border-line p-4">
                <h2 className="font-semibold">{col.name}</h2>
                <Badge tone="warn">{waiting} waiting</Badge>
                {current && <Badge tone="accent">Now: #{current.token}</Badge>}
              </div>
              <ol className="p-2">
                {col.items.map((i) => <QueueRow key={i.appointmentId} item={i} onRefunded={voucher.print} />)}
              </ol>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
