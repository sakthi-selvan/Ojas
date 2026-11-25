import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, FileText, Printer, ScanBarcode, Tags, TestTubes, X } from "lucide-react";
import {
  SAMPLE_LABEL, TEST_STATUS_LABEL, ageLabel, labTestOf, type LabOrderDetail, type LabOrderSummary, type LabSample, type TestStatus,
} from "@ojas/shared";
import { api, dateTimeLabel, timeLabel, today } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, Field, cx } from "../../components/ui";
import { ResultCard, statusTone } from "./ResultCard";
import { usePrint } from "./printables";

type Filter = "ALL" | TestStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "ORDERED", label: TEST_STATUS_LABEL.ORDERED },
  { id: "COLLECTED", label: "To enter" },
  { id: "RESULTED", label: TEST_STATUS_LABEL.RESULTED },
  { id: "VERIFIED", label: TEST_STATUS_LABEL.VERIFIED },
];

/** The lab's day: orders on the left (scan a tube or type a name to find one), the open order on the right. */
export function Worklist({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [date, setDate] = useState(today());
  const [filter, setFilter] = useState<Filter>("ALL");
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const orders = useQuery({ queryKey: ["lab-orders", date], queryFn: () => api.labOrders(date), refetchInterval: 60_000 });
  const term = find.trim().toLowerCase();
  const shown = (orders.data ?? []).filter((o) =>
    (filter === "ALL" || o.tests.some((t) => t.status === filter))
    && (!term || o.patient.name.toLowerCase().includes(term) || o.patient.uhid.toLowerCase().includes(term) || o.orderNo.toLowerCase().includes(term)
      || o.tests.some((t) => t.accessionNo?.toLowerCase() === term)),
  );
  useHotkeys({ F3: () => findRef.current?.focus() });

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[24rem_1fr]">
      <Card className={cx("flex flex-col", openId && "hidden lg:flex")}>
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <div className="flex gap-2">
            <Field ref={findRef} label="Find (F3)" className="flex-1" value={find} placeholder="Scan a tube, or type a name" onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && shown.length === 1) { onOpen(shown[0]!.id); setFind(""); } }} />
            <Field label="Date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} className="w-40" />
          </div>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
            {FILTERS.map((f) => {
              const n = (orders.data ?? []).filter((o) => f.id === "ALL" || o.tests.some((t) => t.status === f.id)).length;
              return (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                  className={cx("rounded-full border px-3 py-1 text-xs", filter === f.id ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:text-ink")}>
                  {f.label} <span className="tabular-nums">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
        {orders.error && <div className="p-3"><Alert tone="danger">{orders.error.message}</Alert></div>}
        {orders.data && shown.length === 0 && (
          <p className="flex items-center gap-2 p-4 text-sm text-ink-3"><ScanBarcode aria-hidden className="size-4" /> {orders.data.length ? "Nothing matches." : "No lab orders on this day."}</p>
        )}
        <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
          {shown.map((o) => <OrderRow key={o.id} o={o} active={o.id === openId} onOpen={() => onOpen(o.id)} />)}
        </ul>
      </Card>
      {openId ? <OrderView key={openId} id={openId} onClose={() => onOpen(null)} /> : (
        <Card className="hidden p-8 text-center text-sm text-ink-3 lg:block">Pick an order, or scan a sample's barcode into Find.</Card>
      )}
    </div>
  );
}

function OrderRow({ o, active, onOpen }: { o: LabOrderSummary; active: boolean; onOpen: () => void }) {
  const c = labTestOf(o.tests);
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? "true" : undefined}
        className={cx("flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-surface-2", active && "bg-accent-soft")}>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold">{o.patient.name}</span>
          {o.critical && <AlertOctagon aria-label="Critical value" className="size-4 text-danger" />}
          <span className="text-xs text-ink-3">{timeLabel(o.orderedAt)}</span>
        </span>
        <span className="truncate text-xs text-ink-3">{o.orderNo} · {o.patient.uhid} · {o.tests.map((t) => t.code).join(", ")}</span>
        <span className="flex flex-wrap gap-1">
          {c.due > 0 && <Badge tone="warn">{c.due} sample due</Badge>}
          {c.waiting > 0 && <Badge>{c.waiting} to enter</Badge>}
          {c.toVerify > 0 && <Badge tone="accent">{c.toVerify} to verify</Badge>}
          {c.ready > 0 && <Badge tone="ok">{c.ready} ready</Badge>}
        </span>
      </button>
    </li>
  );
}

function OrderView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const order = useQuery({ queryKey: ["lab-order", id], queryFn: () => api.labOrder(id) });
  const { print, view } = usePrint();
  const update = (o: LabOrderDetail) => {
    qc.setQueryData(["lab-order", o.id], o);
    void qc.invalidateQueries({ queryKey: ["lab-orders"] });
  };
  const collect = useMutation({
    mutationFn: () => api.collectSamples(id),
    onSuccess: (o) => {
      update(o);
      const fresh = o.samples.filter((s) => !order.data?.samples.some((x) => x.id === s.id)).map((s) => s.id);
      print({ kind: "labels", order: o, sampleIds: fresh });
    },
  });
  useEffect(() => { if (order.data) window.scrollTo({ top: 0 }); }, [id, order.data?.id]);
  useHotkeys({ Escape: onClose });

  if (order.error) return <Alert tone="danger">{order.error.message}</Alert>;
  const o = order.data;
  if (!o) return <Card className="p-6 text-sm text-ink-3">Loading…</Card>;
  const due = o.tests.filter((t) => t.status === "ORDERED");
  const verified = o.tests.some((t) => t.status === "VERIFIED");

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold">{o.patient.name} <span className="text-sm font-normal text-ink-3">{o.patient.uhid}</span></h2>
            <p className="text-sm text-ink-2">
              {o.patient.dob ? ageLabel(o.patient.dob) : "Age not known"} · {o.patient.sex} · {o.patient.phone} · Ref: {o.referredBy || "Self"}
            </p>
            <p className="text-xs text-ink-3">{o.orderNo} · billed {dateTimeLabel(o.orderedAt)} by {o.billedBy}</p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close order"><X aria-hidden className="size-4" /></Button>
        </div>
        {o.critical && <Alert tone="danger">This order has a critical value. Make sure the doctor has been told.</Alert>}
        <div className="flex flex-wrap gap-2">
          {due.length > 0 && can("lab.collect") && (
            <Button variant="primary" onClick={() => collect.mutate()} disabled={collect.isPending}>
              <TestTubes aria-hidden className="size-4" /> Take {due.length === o.tests.length ? "samples" : "remaining samples"} & print labels
            </Button>
          )}
          {o.samples.some((s) => !s.rejectedAt) && <Button onClick={() => print({ kind: "labels", order: o })}><Tags aria-hidden className="size-4" /> Reprint labels</Button>}
          <Button disabled={!verified} onClick={() => print({ kind: "report", order: o })}><FileText aria-hidden className="size-4" /> Print report{verified && o.tests.some((t) => t.status !== "VERIFIED") ? " (partial)" : ""}</Button>
          <Button variant="ghost" onClick={() => print({ kind: "bill", order: o })}><Printer aria-hidden className="size-4" /> Bill</Button>
        </div>
        {collect.error && <Alert tone="danger">{collect.error.message}</Alert>}
        {o.samples.length > 0 && <Samples order={o} onChange={update} />}
      </Card>
      {o.tests.map((t) => <ResultCard key={t.id} order={o} test={t} />)}
      {view}
    </div>
  );
}

function Samples({ order, onChange }: { order: LabOrderDetail; onChange: (o: LabOrderDetail) => void }) {
  const { can } = useAuth();
  const [rejecting, setRejecting] = useState<LabSample | null>(null);
  const [reason, setReason] = useState("");
  const reject = useMutation({
    mutationFn: () => api.rejectSample(rejecting!.id, { reason }),
    onSuccess: (o) => { onChange(o); setRejecting(null); setReason(""); },
  });
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1 text-sm">
        {order.samples.map((s) => (
          <li key={s.id} className={cx("flex flex-wrap items-center gap-2", s.rejectedAt && "text-ink-3 line-through")}>
            <span className="font-mono font-semibold">{s.accessionNo}</span>
            <span>{SAMPLE_LABEL[s.sampleType]}</span>
            <span className="text-xs text-ink-3">taken {timeLabel(s.collectedAt)} by {s.collectedBy}</span>
            {s.rejectedAt ? <Badge tone="danger">Rejected: {s.rejectReason}</Badge> : can("lab.collect") && (
              <Button variant="ghost" className="ml-auto min-h-7 px-2 text-xs" onClick={() => setRejecting(s)}>Reject sample</Button>
            )}
          </li>
        ))}
      </ul>
      {rejecting && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <Field label={`Why reject ${rejecting.accessionNo}?`} className="min-w-64 flex-1" value={reason} autoFocus placeholder="Haemolysed, clotted, too little…" onChange={(e) => setReason(e.target.value)} />
          <Button variant="primary" disabled={reason.trim().length < 3 || reject.isPending} onClick={() => reject.mutate()}>Reject, take a new one</Button>
          <Button onClick={() => setRejecting(null)}>Cancel</Button>
          {reject.error && <div className="w-full"><Alert tone="danger">{reject.error.message}</Alert></div>}
        </div>
      )}
    </div>
  );
}
