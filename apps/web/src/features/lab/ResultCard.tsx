import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, CheckCircle2, PencilLine } from "lucide-react";
import {
  FLAG_LABEL, SAMPLE_LABEL, TEST_STATUS_LABEL, ageYears, interpret, isCritical, pickRange, rangeText,
  type LabOrderDetail, type LabResult, type OrderTest, type Parameter, type ResultFlag,
} from "@ojas/shared";
import { api, ApiError, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, cx } from "../../components/ui";

export const statusTone = (s: OrderTest["status"]) => (s === "VERIFIED" ? "ok" : s === "RESULTED" ? "accent" : s === "COLLECTED" ? "neutral" : "warn") as "ok" | "accent" | "neutral" | "warn";

export function FlagBadge({ flag }: { flag: ResultFlag | null }) {
  if (!flag) return null;
  return <Badge tone={isCritical(flag) || flag === "A" ? "danger" : "warn"}>{FLAG_LABEL[flag]}</Badge>;
}

/** One test on an order: results typed in with live flags, then saved, verified, or amended. */
export function ResultCard({ order, test }: { order: LabOrderDetail; test: OrderTest }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = (test.status === "COLLECTED" || test.status === "RESULTED") && can("lab.result");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["lab-order", order.id] });
    void qc.invalidateQueries({ queryKey: ["lab-orders"] });
  };

  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby={`t-${test.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`t-${test.id}`} className="font-semibold">{test.name}</h3>
        <span className="font-mono text-xs text-ink-3">{test.code}</span>
        <Badge tone={statusTone(test.status)}>{TEST_STATUS_LABEL[test.status]}</Badge>
        {test.accessionNo && <span className="text-xs text-ink-3">Sample {test.accessionNo}</span>}
        <span className="ml-auto text-xs text-ink-3">Due {dateTimeLabel(test.dueAt)}</span>
      </div>
      {test.amendReason && test.status !== "VERIFIED" && <Alert tone="warn">Being amended: {test.amendReason}</Alert>}
      {test.status === "ORDERED" && <p className="text-sm text-ink-3">Waiting for the sample: {SAMPLE_LABEL[test.sampleType]}.</p>}
      {editable && <Entry key={test.rowVersion} order={order} test={test} onSaved={refresh} />}
      {!editable && test.status !== "ORDERED" && <ResultTable test={test} />}
      {test.status === "VERIFIED" && <Verified test={test} onAmended={refresh} />}
    </Card>
  );
}

export function ResultTable({ test }: { test: Pick<OrderTest, "parameters" | "results" | "remarks"> }) {
  if (!test.results.length) return <p className="text-sm text-ink-3">No results entered yet.</p>;
  return (
    <div className="flex flex-col gap-1">
      <table className="w-full text-sm">
        <tbody>
          {test.parameters.map((p) => {
            const r = test.results.find((x) => x.paramId === p.id);
            if (!r) return null;
            return (
              <tr key={p.id} className="border-b border-line">
                <td className="py-1.5 pr-2">{p.name}</td>
                <td className={cx("py-1.5 pr-2 tabular-nums", r.flag && "font-semibold", isCritical(r.flag) && "text-danger")}>{r.value} {p.unit && <span className="font-normal text-ink-3">{p.unit}</span>}</td>
                <td className="py-1.5 pr-2"><FlagBadge flag={r.flag} /></td>
                <td className="py-1.5 text-xs text-ink-3">{r.refText}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {test.remarks && <p className="text-sm"><span className="text-ink-3">Remarks:</span> {test.remarks}</p>}
    </div>
  );
}

function Entry({ order, test, onSaved }: { order: LabOrderDetail; test: OrderTest; onSaved: () => void }) {
  const { can } = useAuth();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(test.results.map((r) => [r.paramId, r.value])));
  const [remarks, setRemarks] = useState(test.remarks);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const age = ageYears(order.patient.dob, new Date(order.orderedAt));
  const preview = (p: Parameter): LabResult | null => (values[p.id]?.trim() ? interpret(p, values[p.id]!, order.patient.sex, age) : null);
  const critical = test.parameters.map(preview).filter((r) => r && isCritical(r.flag));

  const save = useMutation({
    mutationFn: async (andVerify: boolean) => {
      const saved = await api.saveResults(test.id, { values, remarks, rowVersion: test.rowVersion });
      return andVerify ? api.verifyResult(test.id, saved.rowVersion) : saved;
    },
    onSuccess: onSaved,
    onError: (e) => setErrs(e instanceof ApiError ? Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^values\./, ""), v])) : {}),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(false); };
  // Enter moves to the next box, as on a paper worksheet; on the last one it saves.
  const next = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    const boxes = [...e.currentTarget.querySelectorAll<HTMLElement>("input, select, textarea")];
    const i = boxes.indexOf(e.target as HTMLElement);
    if (i >= 0 && i < boxes.length - 1) boxes[i + 1]!.focus();
    else save.mutate(false);
  };
  const filled = test.parameters.some((p) => values[p.id]?.trim());

  return (
    <form onSubmit={submit} onKeyDown={next} className="flex flex-col gap-3">
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {test.parameters.map((p, i) => {
          const r = preview(p);
          const id = `${test.id}-${p.id}`;
          const showGroup = p.group && p.group !== test.parameters[i - 1]?.group;
          return (
            <div key={p.id} className="contents">
              {showGroup && <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-ink-3 sm:col-span-2">{p.group}</div>}
              <div className="flex flex-col gap-1">
                <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-ink-2">
                  {p.name} {p.unit && <span className="font-normal text-ink-3">({p.unit})</span>} <FlagBadge flag={r?.flag ?? null} />
                </label>
                {p.kind === "CHOICE" ? (
                  <select id={id} value={values[p.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                    className="min-h-10 rounded-lg border border-line bg-surface px-2">
                    <option value="">—</option>
                    {p.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    inputMode={p.kind === "NUMERIC" ? "decimal" : undefined}
                    value={values[p.id] ?? ""}
                    autoComplete="off"
                    aria-invalid={errs[p.id] ? true : undefined}
                    aria-describedby={`${id}-ref`}
                    onChange={(e) => { setValues((v) => ({ ...v, [p.id]: e.target.value })); setErrs(({ [p.id]: _, ...rest }) => rest); }}
                    className={cx("min-h-10 rounded-lg border bg-surface px-2 tabular-nums", errs[p.id] ? "border-danger" : "border-line")}
                  />
                )}
                <span id={`${id}-ref`} className={cx("text-xs", errs[p.id] ? "text-danger" : "text-ink-3")}>
                  {errs[p.id] ?? (rangeText(p, pickRange(p.ranges, order.patient.sex, age)) || " ")}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <Field label="Remarks (printed on the report)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      {critical.length > 0 && (
        <Alert tone="danger">
          <span className="inline-flex items-center gap-2"><AlertOctagon aria-hidden className="size-4" /> Critical value. Tell the doctor now; it's marked on the report.</span>
        </Alert>
      )}
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>Save</Button>
        {can("lab.verify") && <Button variant="primary" disabled={!filled || save.isPending} onClick={() => save.mutate(true)}><CheckCircle2 aria-hidden className="size-4" /> Save & verify</Button>}
      </div>
    </form>
  );
}

function Verified({ test, onAmended }: { test: OrderTest; onAmended: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const amend = useMutation({ mutationFn: () => api.amendResult(test.id, { reason }), onSuccess: onAmended });
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-ink-3">
        Verified by {test.verifiedBy} · {test.verifiedAt && dateTimeLabel(test.verifiedAt)}
        {can("lab.verify") && !open && <Button variant="ghost" className="ml-auto min-h-8 px-2 text-xs" onClick={() => setOpen(true)}><PencilLine aria-hidden className="size-3.5" /> Amend</Button>}
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Why does it need changing?" className="min-w-64 flex-1" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
            error={amend.error instanceof ApiError ? (amend.error.fields.reason ?? amend.error.message) : undefined} />
          <Button variant="primary" disabled={reason.trim().length < 5 || amend.isPending} onClick={() => amend.mutate()}>Reopen for correction</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
