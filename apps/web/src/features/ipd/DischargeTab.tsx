import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FilePenLine, FlaskConical, Pill, Plus, Printer, Trash2, X } from "lucide-react";
import {
  DISCHARGE_TYPE_LABEL, DischargeType, FLAG_LABEL, MED_TIMING_LABEL, MedTiming, formatINR, roomTax, taxOf,
  type Admission, type DischargeSummary, type Medication, type PaymentMode,
} from "@ojas/shared";
import { api, ApiError, dateLabel, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, Select, cx } from "../../components/ui";
import { SuggestInput } from "../consult/SuggestInput";
import { medLine } from "../consult/Prescription";
import { PaymentModeField, paiseOf } from "./common";
import { useAdmissionUpdate } from "./AdmissionView";
import type { IpdPrintJob } from "./printables";

interface Draft {
  dischargeType: DischargeType;
  diagnoses: { text: string; code: string }[];
  presentingComplaints: string;
  courseInHospital: string;
  investigations: string;
  treatmentGiven: string;
  conditionAtDischarge: string;
  medications: Medication[];
  advice: string;
  followUpDate: string;
}

const draftOf = (s: DischargeSummary | null, a: Admission): Draft => ({
  dischargeType: s?.dischargeType ?? "NORMAL",
  diagnoses: s?.diagnoses ?? [],
  presentingComplaints: s?.presentingComplaints ?? "",
  courseInHospital: s?.courseInHospital ?? "",
  investigations: s?.investigations ?? "",
  treatmentGiven: s?.treatmentGiven ?? "",
  conditionAtDischarge: s?.conditionAtDischarge ?? "",
  medications: s?.medications ?? [],
  advice: s?.advice ?? "",
  followUpDate: s?.followUpDate ?? "",
});

/** The doctor writes and signs the discharge summary; then the desk settles the bill and the patient goes home. */
export function DischargeTab({ admission: a, print }: { admission: Admission; print: (job: IpdPrintJob) => void }) {
  const { can } = useAuth();
  const open = a.status === "ADMITTED";
  const editable = open && can("ipd.orders");
  const [amending, setAmending] = useState(false);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[1fr_26rem]">
      {editable || amending ? <SummaryEditor key={a.summaryVersion} admission={a} amend={amending ? () => setAmending(false) : undefined} /> : <SummaryView admission={a} />}
      <aside className="flex flex-col gap-4">
        {open && can("ipd.bill") && <Settle admission={a} print={print} />}
        {!open && (
          <Card className="flex flex-col gap-3 p-4">
            <h2 className="font-semibold">Discharged {a.dischargedAt && dateTimeLabel(a.dischargedAt)}</h2>
            <p className="text-sm text-ink-2">Final bill {a.finalBillNo}: {formatINR(a.bill.total)}{a.bill.discount ? ` after ${formatINR(a.bill.discount)} discount` : ""}.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => print({ kind: "bill", admission: a })}><Printer aria-hidden className="size-4" /> Final bill</Button>
              {a.summary && <Button onClick={() => print({ kind: "summary", admission: a })}><Printer aria-hidden className="size-4" /> Summary</Button>}
            </div>
            {a.summary && can("ipd.orders") && !amending && (
              <Button variant="ghost" className="self-start" onClick={() => setAmending(true)}><FilePenLine aria-hidden className="size-4" /> Correct the summary</Button>
            )}
          </Card>
        )}
        {a.amendments.length > 0 && (
          <Card className="flex flex-col gap-2 p-4" aria-labelledby="amend-h">
            <h2 id="amend-h" className="font-semibold">Corrections after discharge</h2>
            <ol className="flex flex-col gap-2 text-sm">
              {a.amendments.map((x) => (
                <li key={x.version}><span className="text-ink-3">{dateTimeLabel(x.at)} · {x.by}:</span> {x.reason}</li>
              ))}
            </ol>
          </Card>
        )}
      </aside>
    </div>
  );
}

function SummaryView({ admission: a }: { admission: Admission }) {
  const s = a.summary;
  if (!s) return <Card className="p-4 text-ink-3">The doctor hasn't written the discharge summary yet.</Card>;
  const block = (title: string, text: string) => text && (
    <div><h3 className="text-sm font-semibold text-ink-2">{title}</h3><p className="whitespace-pre-wrap">{text}</p></div>
  );
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Discharge summary</h2>
        {a.summarySignedAt ? <Badge tone="ok">Signed by {a.summarySignedBy}</Badge> : <Badge tone="warn">Draft, not signed</Badge>}
        {s.dischargeType !== "NORMAL" && <Badge tone="danger">{DISCHARGE_TYPE_LABEL[s.dischargeType]}</Badge>}
      </div>
      {s.diagnoses.length > 0 && <div><h3 className="text-sm font-semibold text-ink-2">Final diagnosis</h3><ul className="list-disc pl-5">{s.diagnoses.map((d, i) => <li key={i}>{d.text}{d.code && ` (${d.code})`}</li>)}</ul></div>}
      {block("Presenting complaints", s.presentingComplaints)}
      {block("Course in hospital", s.courseInHospital)}
      {block("Investigations", s.investigations)}
      {block("Treatment given", s.treatmentGiven)}
      {block("Condition at discharge", s.conditionAtDischarge)}
      {s.medications.length > 0 && <div><h3 className="text-sm font-semibold text-ink-2">Medicines to continue</h3><ol className="list-decimal pl-5">{s.medications.map((m, i) => <li key={i}><b>{m.drug}</b> · {medLine(m)}{m.instructions ? ` · ${m.instructions}` : ""}</li>)}</ol></div>}
      {block("Advice", s.advice)}
      {s.followUpDate && <p><b>Review on</b> {dateLabel(s.followUpDate)}</p>}
    </Card>
  );
}

/** Writing the summary before discharge; with `amend`, correcting the signed one after discharge (needs a reason, and re-signs it). */
function SummaryEditor({ admission: a, amend }: { admission: Admission; amend?: () => void }) {
  const qc = useQueryClient();
  const updated = useAdmissionUpdate();
  const initial = useRef(draftOf(a.summary, a));
  const [d, setD] = useState<Draft>(initial.current);
  const [dx, setDx] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(d) !== JSON.stringify(initial.current);
  const signed = !!a.summarySignedAt;

  const save = useMutation({
    mutationFn: () => api.saveSummary(a.id, { ...d, followUpDate: d.followUpDate || null, medications: d.medications.filter((m) => m.drug.trim()), summaryVersion: a.summaryVersion }),
    onSuccess: (x) => { setErrs({}); updated(x); },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  const sign = useMutation({
    mutationFn: async () => {
      const saved = dirty ? await api.saveSummary(a.id, { ...d, followUpDate: d.followUpDate || null, medications: d.medications.filter((m) => m.drug.trim()), summaryVersion: a.summaryVersion }) : a;
      return api.signSummary(a.id, saved.summaryVersion);
    },
    onSuccess: (x) => { setErrs({}); updated(x); },
    onError: (e) => {
      setErrs(e instanceof ApiError ? e.fields : {});
      void qc.invalidateQueries({ queryKey: ["ipd-admission", a.id] });
    },
  });
  const correct = useMutation({
    mutationFn: () => api.amendSummary(a.id, { ...d, followUpDate: d.followUpDate || null, medications: d.medications.filter((m) => m.drug.trim()), summaryVersion: a.summaryVersion, reason }),
    onSuccess: (x) => { setErrs({}); updated(x); amend?.(); },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  const fromChart = () => set({
    medications: [
      ...d.medications,
      ...a.meds.filter((m) => !m.stoppedAt && !d.medications.some((x) => x.drug === m.med.drug)).map(({ med: { route: _, ...m } }) => m),
    ],
  });
  // Tests done in OPD on the day of admission belong in the summary too.
  const labFrom = new Date(new Date(a.admittedAt).getTime() - 86_400_000).toISOString();
  const fromLab = useMutation({
    mutationFn: () => api.patientLabResults(a.patient.id),
    onSuccess: (results) => {
      const mine = results.filter((t) => t.verifiedAt >= labFrom).reverse();
      const lines = mine.map((t) => {
        const flagged = t.results.filter((r) => r.flag).map((r) => {
          const p = t.parameters.find((x) => x.id === r.paramId);
          return `${p?.name ?? r.paramId} ${r.value}${p?.unit ? ` ${p.unit}` : ""} (${FLAG_LABEL[r.flag!].toLowerCase()})`;
        });
        return `${t.name}, ${new Date(t.verifiedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}: ${flagged.length ? flagged.join(", ") : "within normal limits"}`;
      });
      if (lines.length) set({ investigations: [d.investigations.trim(), ...lines].filter(Boolean).join("\n") });
    },
  });
  const area = (k: "presentingComplaints" | "courseInHospital" | "investigations" | "treatmentGiven" | "conditionAtDischarge" | "advice", label: string, rows: number, extra?: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={`sum-${k}`} className="text-sm font-medium text-ink-2">{label}</label>
        {extra}
      </div>
      <textarea id={`sum-${k}`} rows={rows} value={d[k]} onChange={(e) => set({ [k]: e.target.value })} aria-invalid={errs[k] ? true : undefined}
        className={cx("rounded-lg border bg-surface p-3 text-base", errs[k] ? "border-danger" : "border-line")} />
      {errs[k] && <p className="text-sm text-danger">{errs[k]}</p>}
    </div>
  );
  const setMed = (i: number, p: Partial<Medication>) => set({ medications: d.medications.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{amend ? "Correcting the discharge summary" : "Discharge summary"}</h2>
        {signed ? <Badge tone="ok">Signed by {a.summarySignedBy}</Badge> : <Badge tone="warn">Not signed</Badge>}
        {amend && <span className="text-sm text-ink-2">The signed version is kept. Saving signs the corrected one in your name.</span>}
        {!amend && signed && dirty && <span className="text-sm text-warn">Saving changes takes the signature off until you sign again.</span>}
      </div>
      <Select label="Outcome" className="max-w-sm" value={d.dischargeType} onChange={(e) => set({ dischargeType: DischargeType.parse(e.target.value) })}>
        {DischargeType.options.map((t) => <option key={t} value={t}>{DISCHARGE_TYPE_LABEL[t]}</option>)}
      </Select>
      <div className="flex flex-col gap-2">
        <SuggestInput kind="diagnosis" label="Final diagnosis" value={dx} onChange={setDx} placeholder="Type and press Enter"
          onPick={(s) => { if (!d.diagnoses.some((x) => x.text.toLowerCase() === s.text.toLowerCase())) set({ diagnoses: [...d.diagnoses, { text: s.text, code: s.code ?? "" }] }); setDx(""); setErrs(({ diagnoses: _, ...r }) => r); }} />
        {errs.diagnoses && <p className="text-sm text-danger">{errs.diagnoses}</p>}
        {d.diagnoses.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Final diagnosis">
            {d.diagnoses.map((x, i) => (
              <li key={x.text + i} className="flex items-center gap-1 rounded-full bg-accent-soft py-1 pl-3 pr-1 text-sm font-medium text-accent">
                {x.text}{x.code && <span className="text-xs opacity-70">{x.code}</span>}
                <button type="button" aria-label={`Remove ${x.text}`} onClick={() => set({ diagnoses: d.diagnoses.filter((_, j) => j !== i) })} className="grid size-6 place-items-center rounded-full hover:bg-surface"><X aria-hidden className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {area("presentingComplaints", "Presenting complaints", 2)}
      {area("courseInHospital", "Course in hospital", 4)}
      {area("investigations", "Investigations", 3,
        <Button variant="ghost" className="ml-auto min-h-8 px-2 text-xs" disabled={fromLab.isPending} onClick={() => fromLab.mutate()}><FlaskConical aria-hidden className="size-3.5" /> Add lab results</Button>)}
      {fromLab.isSuccess && !fromLab.data.some((t) => t.verifiedAt >= labFrom) && <p className="text-sm text-ink-3">No verified lab results from this admission.</p>}
      {area("treatmentGiven", "Treatment given", 3)}
      {area("conditionAtDischarge", "Condition at discharge", 2)}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-ink-2">Medicines to continue at home</h3>
          <Button variant="ghost" className="ml-auto min-h-8 px-2 text-xs" onClick={fromChart} disabled={!a.meds.some((m) => !m.stoppedAt)}><Pill aria-hidden className="size-3.5" /> Copy from treatment chart</Button>
          <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => set({ medications: [...d.medications, { drug: "", dose: "", frequency: "", timing: "AFTER_FOOD", durationDays: null, instructions: "" }] })}><Plus aria-hidden className="size-3.5" /> Add</Button>
        </div>
        <datalist id="sum-frequencies">{["1-0-1", "1-1-1", "1-0-0", "0-0-1", "SOS"].map((f) => <option key={f} value={f} />)}</datalist>
        {d.medications.map((m, i) => (
          <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-line p-2 sm:grid-cols-[2fr_1fr_1fr_9rem_5rem_auto]">
            <Field label="Medicine" className="col-span-2 sm:col-span-1" value={m.drug} onChange={(e) => setMed(i, { drug: e.target.value })} />
            <Field label="Dose" value={m.dose} onChange={(e) => setMed(i, { dose: e.target.value })} />
            <Field label="When" value={m.frequency} list="sum-frequencies" onChange={(e) => setMed(i, { frequency: e.target.value })} />
            <Select label="Food" value={m.timing} onChange={(e) => setMed(i, { timing: MedTiming.parse(e.target.value) })}>
              {MedTiming.options.map((t) => <option key={t} value={t}>{MED_TIMING_LABEL[t] || "Any time"}</option>)}
            </Select>
            <Field label="Days" inputMode="numeric" value={m.durationDays == null ? "" : String(m.durationDays)} onChange={(e) => setMed(i, { durationDays: e.target.value === "" ? null : Number(e.target.value) || null })} />
            <Button variant="ghost" aria-label={`Remove ${m.drug || "medicine"}`} onClick={() => set({ medications: d.medications.filter((_, j) => j !== i) })}><Trash2 aria-hidden className="size-4" /></Button>
          </div>
        ))}
      </div>
      {area("advice", "Advice", 3)}
      <Field label="Review on" type="date" className="max-w-xs" value={d.followUpDate} onChange={(e) => set({ followUpDate: e.target.value })} error={errs.followUpDate} />

      {amend && <Field label="What was corrected, and why" value={reason} onChange={(e) => setReason(e.target.value)} error={errs.reason} placeholder="Added hypokalaemia from the potassium report" />}
      {(save.error || sign.error || correct.error) && !Object.keys(errs).length && <Alert tone="danger">{(correct.error ?? sign.error ?? save.error)!.message}</Alert>}
      {amend ? (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
          <Button variant="primary" size="lg" disabled={!dirty || reason.trim().length < 5 || correct.isPending} onClick={() => correct.mutate()}>
            <CheckCircle2 aria-hidden className="size-5" /> {correct.isPending ? "Saving…" : "Save & sign correction"}
          </Button>
          <Button size="lg" onClick={amend}>Cancel</Button>
        </div>
      ) : (
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
        <Button size="lg" disabled={!dirty || save.isPending || sign.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save draft"}</Button>
        <Button variant="primary" size="lg" disabled={(signed && !dirty) || sign.isPending || save.isPending} onClick={() => sign.mutate()}>
          <CheckCircle2 aria-hidden className="size-5" /> {signed && !dirty ? "Signed" : "Sign & advise discharge"}
        </Button>
        <span className="text-sm text-ink-3">{signed ? "The desk can now settle the bill." : "Signing tells the desk the patient can go home."}</span>
      </div>
      )}
    </Card>
  );
}

function Settle({ admission: a, print }: { admission: Admission; print: (job: IpdPrintJob) => void }) {
  const { can } = useAuth();
  const updated = useAdmissionUpdate();
  const [discountText, setDiscountText] = useState("");
  const [mode, setMode] = useState<PaymentMode>("CASH");
  const key = useRef(crypto.randomUUID());
  const b = a.bill;
  const discount = can("billing.discount") ? paiseOf(discountText) : 0;
  const tax = taxOf(roomTax(b.taxLines, b.subtotal, Math.min(discount, b.subtotal)));
  const balance = b.subtotal - discount + tax - b.paid;
  const settle = useMutation({
    mutationFn: () => api.discharge(a.id, { discount, paymentMode: mode, expectedSubtotal: b.subtotal, idempotencyKey: key.current }),
    onSuccess: (x) => {
      updated(x);
      print({ kind: "bill", admission: x });
    },
    onError: (e) => { if (e instanceof ApiError && e.status < 500) key.current = crypto.randomUUID(); },
  });
  const errs = settle.error instanceof ApiError ? settle.error.fields : {};
  if (!a.summarySignedAt) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="font-semibold">Settle and discharge</h2>
        <p className="text-sm text-ink-2">Waiting for the doctor to sign the discharge summary. Bill so far: <b>{formatINR(b.total)}</b>, paid {formatINR(b.paid)}.</p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby="settle-h">
      <h2 id="settle-h" className="font-semibold">Settle and discharge</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>Total ({b.days} {b.days === 1 ? "day" : "days"})</dt><dd className="text-right tabular-nums">{formatINR(b.subtotal)}</dd>
        {discount > 0 && <><dt>Discount</dt><dd className="text-right tabular-nums">− {formatINR(discount)}</dd></>}
        {tax > 0 && <><dt>GST on room rent</dt><dd className="text-right tabular-nums">{formatINR(tax)}</dd></>}
        <dt>Advance paid</dt><dd className="text-right tabular-nums">− {formatINR(b.paid)}</dd>
      </dl>
      {can("billing.discount") && <Field label="Discount ₹" inputMode="decimal" value={discountText} onChange={(e) => setDiscountText(e.target.value)} error={errs.discount} />}
      <div className={cx("rounded-lg p-3", balance > 0 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>
        <div className="text-sm">{balance > 0 ? "Collect" : balance < 0 ? "Refund to the patient" : "Nothing to collect"}</div>
        <div className="text-3xl font-bold tabular-nums">{formatINR(Math.abs(balance))}</div>
      </div>
      {balance !== 0 && <PaymentModeField name="settle-mode" value={mode} onChange={setMode} />}
      {settle.error && !Object.keys(errs).length && <Alert tone="danger">{settle.error.message}</Alert>}
      <Button variant="primary" size="lg" disabled={settle.isPending || discount > b.subtotal} onClick={() => settle.mutate()}>
        {balance > 0 ? `Receive ${formatINR(balance)} & discharge` : balance < 0 ? `Refund ${formatINR(-balance)} & discharge` : "Discharge"}
      </Button>
      <p className="text-xs text-ink-3">The final bill prints, the record is locked, and the bed goes for cleaning.</p>
    </Card>
  );
}
