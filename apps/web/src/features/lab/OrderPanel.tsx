import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, BedDouble, CheckCircle2, ClipboardList, CreditCard, Printer, Smartphone, TestTubes, Trash2, X } from "lucide-react";
import { SAMPLE_LABEL, ageLabel, formatINR, type LabOrderDetail, type LabPatient, type LabRequest, type LabTest, type CounterMode } from "@ojas/shared";
import { api, ApiError, timeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, Field, Segmented } from "../../components/ui";
import { PatientStep } from "../front-desk/PatientStep";
import { TestSearch } from "./TestSearch";
import { usePrint } from "./printables";

/**
 * Billing tests: pick the patient (or a consultation's request on the right, which brings the
 * patient, the doctor and the tests), add tests (F2), F9 bills. Samples can be taken straight away.
 */
export function OrderPanel({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [patient, setPatient] = useState<LabPatient | null>(null);
  const [appointmentId, setAppointmentId] = useState<string>();
  const [referredBy, setReferredBy] = useState("");
  const [tests, setTests] = useState<LabTest[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [mode, setMode] = useState<CounterMode>("CASH");
  const [discountText, setDiscountText] = useState("");
  const [done, setDone] = useState<LabOrderDetail | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const search = useRef<HTMLInputElement>(null);
  const idemKey = useRef(crypto.randomUUID());
  const requests = useQuery({ queryKey: ["lab-requests"], queryFn: api.labRequests, refetchInterval: 30_000 });
  const inpatients = useQuery({ queryKey: ["ipd-inpatients"], queryFn: api.inpatients });
  /** An admitted patient's tests can go on their in-patient bill instead of being paid now. */
  const ip = patient ? inpatients.data?.find((i) => i.patient.id === patient.id) : undefined;
  const payMode: CounterMode = mode === "IPD" && !ip ? "CASH" : mode;
  const choose = (p: LabPatient) => {
    setPatient(p);
    const admitted = inpatients.data?.find((i) => i.patient.id === p.id);
    setMode(admitted ? "IPD" : "CASH");
    if (admitted) setReferredBy((r) => r || admitted.doctorName);
  };

  const canDiscount = can("billing.discount");
  const subtotal = tests.reduce((s, t) => s + t.price, 0);
  const discount = canDiscount ? Math.round((Number(discountText.replace(/[^\d.]/g, "")) || 0) * 100) : 0;
  const unpriced = tests.filter((t) => t.price <= 0);

  const load = (r: LabRequest) => {
    choose(r.patient);
    setAppointmentId(r.appointmentId);
    setReferredBy(r.prescriber);
    setTests(r.lines.flatMap((l) => (l.match && l.match.active ? [l.match] : [])).filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i));
    setUnmatched(r.lines.filter((l) => !l.match).map((l) => l.test));
    setErrs({});
  };
  const reset = () => {
    setPatient(null);
    setAppointmentId(undefined);
    setReferredBy("");
    setTests([]);
    setUnmatched([]);
    setDiscountText("");
    setDone(null);
    setErrs({});
    idemKey.current = crypto.randomUUID();
  };

  const bill = useMutation({
    mutationFn: () =>
      api.billLab({ patientId: patient!.id, appointmentId, referredBy, testIds: tests.map((t) => t.id), discount, paymentMode: payMode === "IPD" ? "CASH" : payMode, admissionId: payMode === "IPD" ? ip?.admissionId : undefined, idempotencyKey: idemKey.current }),
    onSuccess: (o) => {
      setDone(o);
      void qc.invalidateQueries({ queryKey: ["lab-requests"] });
      void qc.invalidateQueries({ queryKey: ["lab-orders"] });
    },
    onError: (e) => {
      setErrs(e instanceof ApiError ? e.fields : {});
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });
  const submit = () => !done && patient && tests.length > 0 && !bill.isPending && bill.mutate();
  useHotkeys({ F9: submit, F2: () => search.current?.focus() });

  if (done) return <Card className="p-4 sm:p-6"><Billed order={done} onNext={reset} onOpen={() => onOpenOrder(done.id)} /></Card>;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
      <Card className="flex flex-col gap-4 p-4 sm:p-6">
        {!patient ? (
          <PatientStep onSelect={(p) => choose({ id: p.id, uhid: p.uhid, name: p.name, sex: p.sex, dob: p.dob, phone: p.phone })} />
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{patient.name} <span className="font-normal text-ink-3">· {patient.uhid}</span></div>
                <div className="text-sm text-ink-2">{patient.dob ? ageLabel(patient.dob) : "Age not known"} · {patient.sex === "M" ? "Male" : patient.sex === "F" ? "Female" : "Other"} · {patient.phone}</div>
              </div>
              <Button variant="ghost" onClick={reset} aria-label="Change patient"><X aria-hidden className="size-4" /> Change</Button>
            </div>
            <Field label="Referred by" value={referredBy} onChange={(e) => setReferredBy(e.target.value)} placeholder="Doctor's name, or leave blank for self" />
            <TestSearch ref={search} label="Add test (F2)" placeholder="Code or name, e.g. CBC, sugar, thyroid" onPick={(t) => setTests((ts) => [...ts, t])} exclude={tests.map((t) => t.id)} />
            {unmatched.length > 0 && <Alert tone="warn">Not in the test list, add by hand or skip: {unmatched.join(", ")}</Alert>}
            {tests.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-3">No tests yet. Search above, or pick a doctor's request.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {tests.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-14 shrink-0 font-mono text-xs text-ink-3">{t.code}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{t.name}</span><span className="block truncate text-xs text-ink-3">{SAMPLE_LABEL[t.sampleType]}</span></span>
                    {t.price > 0 ? <span className="tabular-nums">{formatINR(t.price)}</span> : <Badge tone="warn">No price</Badge>}
                    <Button variant="ghost" className="min-h-8 px-2" aria-label={`Remove ${t.name}`} onClick={() => setTests((ts) => ts.filter((x) => x.id !== t.id))}><Trash2 aria-hidden className="size-4" /></Button>
                  </li>
                ))}
              </ul>
            )}
            {unpriced.length > 0 && <Alert tone="danger">{unpriced.map((t) => t.name).join(", ")} {unpriced.length === 1 ? "has" : "have"} no price yet. Set it under Tests.</Alert>}
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <Segmented
                label="Payment"
                name="lab-mode"
                value={payMode}
                onChange={setMode}
                options={[
                  ...(ip ? [{ value: "IPD" as const, label: "IP bill", icon: <BedDouble aria-hidden className="size-4" /> }] : []),
                  { value: "CASH", label: "Cash", icon: <Banknote aria-hidden className="size-4" /> },
                  { value: "UPI", label: "UPI", icon: <Smartphone aria-hidden className="size-4" /> },
                  { value: "CARD", label: "Card", icon: <CreditCard aria-hidden className="size-4" /> },
                ]}
              />
              {canDiscount && <Field label="Discount ₹" inputMode="decimal" value={discountText} onChange={(e) => setDiscountText(e.target.value)} error={errs.discount} />}
            </div>
            {/* Discount errors show beside the field; everything else needs the banner. */}
            {bill.error && !errs.discount && <Alert tone="danger">{bill.error.message}</Alert>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <div>
                <div className="text-sm text-ink-3">{payMode === "IPD" ? `Add to IP bill ${ip?.admissionNo} (${ip?.wardName}, bed ${ip?.bedLabel})` : "To pay"}</div>
                <div className="text-3xl font-bold tabular-nums">{formatINR(Math.max(0, subtotal - discount))}</div>
              </div>
              <Button variant="primary" size="lg" shortcut="F9" disabled={!tests.length || unpriced.length > 0 || bill.isPending} onClick={submit}>{payMode === "IPD" ? "Add to IP bill" : "Bill & take payment"}</Button>
            </div>
          </>
        )}
      </Card>

      <Card aria-labelledby="lab-req">
        <h2 id="lab-req" className="flex items-center gap-2 border-b border-line p-4 font-semibold">
          <ClipboardList aria-hidden className="size-4" /> Doctors' requests <Badge tone="warn">{requests.data?.length ?? 0}</Badge>
        </h2>
        {requests.error && <div className="p-3"><Alert tone="danger">{requests.error.message}</Alert></div>}
        {requests.data?.length === 0 && <p className="p-4 text-sm text-ink-3">Tests ordered in signed consultations appear here until they're billed.</p>}
        <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto">
          {requests.data?.map((r) => (
            <li key={r.appointmentId}>
              <button type="button" className="w-full px-4 py-3 text-left hover:bg-surface-2" onClick={() => load(r)}>
                <div className="font-semibold">{r.patient.name} <span className="text-xs font-normal text-ink-3">{r.patient.uhid}</span></div>
                <div className="text-xs text-ink-2">{r.prescriber} · signed {timeLabel(r.signedAt)}</div>
                <div className="truncate text-xs text-ink-3">{r.lines.map((l) => l.test).join(", ")}</div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Billed({ order, onNext, onOpen }: { order: LabOrderDetail; onNext: () => void; onOpen: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const { print, view } = usePrint();
  const collect = useMutation({
    mutationFn: () => api.collectSamples(order.id),
    onSuccess: (o) => {
      qc.setQueryData(["lab-order", o.id], o);
      void qc.invalidateQueries({ queryKey: ["lab-orders"] });
      print({ kind: "labels", order: o });
    },
  });
  useHotkeys({ P: () => print({ kind: "bill", order }), Enter: onNext, Escape: onNext });
  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex items-center gap-4 rounded-xl bg-ok-soft p-4 text-ok">
        <CheckCircle2 aria-hidden className="size-8 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold">{order.paymentMode === "IPD" ? `${formatINR(order.total)} added to IP bill ${order.admissionNo}` : `Paid ${formatINR(order.total)}`} · {order.orderNo}</div>
          <div className="text-sm">{order.patient.name} · {order.tests.map((t) => t.code).join(", ")}</div>
        </div>
      </div>
      {collect.isSuccess && <Alert tone="ok">Samples recorded and labels sent to the printer: {collect.data.samples.map((s) => s.accessionNo).join(", ")}.</Alert>}
      {collect.error && <Alert tone="danger">{collect.error.message}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" onClick={onNext} shortcut="Enter" autoFocus>Next patient</Button>
        {can("lab.collect") && !collect.isSuccess && (
          <Button size="lg" onClick={() => collect.mutate()} disabled={collect.isPending}><TestTubes aria-hidden className="size-4" /> Take samples & print labels</Button>
        )}
        <Button size="lg" onClick={() => print({ kind: "bill", order })} shortcut="P"><Printer aria-hidden className="size-4" /> Print bill</Button>
        {can("lab.read") && <Button size="lg" variant="ghost" onClick={onOpen}>Open in worklist</Button>}
      </div>
      {view}
    </div>
  );
}
