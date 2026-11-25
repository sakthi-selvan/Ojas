import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react";
import {
  LAB_SECTION_LABEL, LabSection, ParamKind, RangeSex, SAMPLE_LABEL, SampleType, formatINR, pickRange, rangeText,
  type LabTest, type Parameter, type ParameterInput, type TestInput,
} from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, Select } from "../../components/ui";

/** The test catalogue: what the lab does, its price, sample and how each value is read. */
export function TestsPanel() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<LabTest | "new" | null>(null);
  const tests = useQuery({ queryKey: ["lab-tests", "list", q], queryFn: () => api.labTests(q, { all: true }) });
  const starter = useMutation({ mutationFn: api.addStarterTests, onSuccess: () => qc.invalidateQueries({ queryKey: ["lab-tests"] }) });
  const canEdit = can("lab.tests");
  const unpriced = (tests.data ?? []).filter((t) => t.active && t.price <= 0).length;

  if (editing) return <Card className="p-4 sm:p-6"><TestForm test={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} /></Card>;

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Field label="Search" className="min-w-48 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or name" />
        {canEdit && <Button onClick={() => starter.mutate()} disabled={starter.isPending}><Sparkles aria-hidden className="size-4" /> Add common tests</Button>}
        {canEdit && <Button variant="primary" onClick={() => setEditing("new")}><Plus aria-hidden className="size-4" /> New test</Button>}
      </div>
      {starter.data && (
        <div className="p-4 pb-0">
          <Alert tone="ok">
            Added {starter.data.added} common test{starter.data.added === 1 ? "" : "s"}{starter.data.skipped ? ` (${starter.data.skipped} you already had)` : ""}. Set each one's price, and check the reference ranges against your own analysers before issuing reports.
          </Alert>
        </div>
      )}
      {unpriced > 0 && <div className="p-4 pb-0"><Alert tone="warn">{unpriced} test{unpriced === 1 ? " has" : "s have"} no price yet and can't be billed.</Alert></div>}
      {tests.data?.length === 0 && <p className="p-4 text-sm text-ink-3">{q ? "No match." : "No tests yet. Add the common ones with one click, then set your prices."}</p>}
      {!!tests.data?.length && (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-ink-3">
            <th scope="col" className="p-3 font-medium">Code</th><th scope="col" className="p-3 font-medium">Test</th><th scope="col" className="p-3 font-medium">Sample</th>
            <th scope="col" className="p-3 text-right font-medium">Price</th><th scope="col" className="p-3 font-medium">Report in</th><th scope="col"><span className="sr-only">Edit</span></th>
          </tr></thead>
          <tbody>
            {tests.data.map((t) => (
              <tr key={t.id} className="border-b border-line">
                <td className="p-3 font-mono text-xs">{t.code}</td>
                <td className="p-3">
                  <div className="flex flex-wrap items-center gap-2 font-semibold">{t.name} {!t.active && <Badge>Not offered</Badge>}</div>
                  <div className="text-xs text-ink-3">{LAB_SECTION_LABEL[t.section]} · {t.parameters.length} parameter{t.parameters.length === 1 ? "" : "s"}</div>
                </td>
                <td className="p-3 text-xs">{SAMPLE_LABEL[t.sampleType]}</td>
                <td className="p-3 text-right tabular-nums">{t.price > 0 ? formatINR(t.price) : <Badge tone="warn">Set price</Badge>}</td>
                <td className="p-3">{t.tatHours} h</td>
                <td className="p-3 text-right">{canEdit && <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setEditing(t)}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ───────────────────────── Editing ─────────────────────────

const str = (n: number | null | undefined) => (n == null ? "" : String(n));
const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const slug = (name: string, taken: string[]) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "p";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
};

interface RangeDraft { sex: RangeSex; ageFrom: string; ageTo: string; low: string; high: string }
interface ParamDraft {
  id: string; isNew: boolean; name: string; unit: string; kind: ParamKind; decimals: string; group: string; ranges: RangeDraft[];
  criticalLow: string; criticalHigh: string; choices: string; normal: string; refText: string;
}

const toDraft = (p: Parameter): ParamDraft => ({
  id: p.id, isNew: false, name: p.name, unit: p.unit, kind: p.kind, decimals: String(p.decimals), group: p.group,
  ranges: p.ranges.map((r) => ({ sex: r.sex, ageFrom: str(r.ageFrom), ageTo: str(r.ageTo), low: str(r.low), high: str(r.high) })),
  criticalLow: str(p.criticalLow), criticalHigh: str(p.criticalHigh), choices: p.choices.join(", "), normal: p.normal, refText: p.refText,
});
const blankParam = (): ParamDraft => ({
  id: "", isNew: true, name: "", unit: "", kind: "NUMERIC", decimals: "1", group: "", ranges: [{ sex: "ANY", ageFrom: "", ageTo: "", low: "", high: "" }],
  criticalLow: "", criticalHigh: "", choices: "", normal: "", refText: "",
});

function fromDraft(p: ParamDraft): ParameterInput {
  return {
    id: p.id, name: p.name, unit: p.unit, kind: p.kind, decimals: Number(p.decimals) || 0, group: p.group,
    ranges: p.kind === "NUMERIC"
      ? p.ranges.filter((r) => r.low.trim() || r.high.trim()).map((r) => ({ sex: r.sex, ageFrom: numOrNull(r.ageFrom), ageTo: numOrNull(r.ageTo), low: numOrNull(r.low), high: numOrNull(r.high) }))
      : [],
    criticalLow: p.kind === "NUMERIC" ? numOrNull(p.criticalLow) : null,
    criticalHigh: p.kind === "NUMERIC" ? numOrNull(p.criticalHigh) : null,
    choices: p.kind === "CHOICE" ? list(p.choices) : [],
    normal: p.kind === "NUMERIC" ? "" : p.normal,
    refText: p.refText,
  };
}

function TestForm({ test, onDone }: { test?: LabTest; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: test?.code ?? "", name: test?.name ?? "", section: test?.section ?? ("BIOCHEM" as LabSection), sampleType: test?.sampleType ?? ("SERUM" as SampleType),
    price: test ? String(test.price / 100) : "", tatHours: String(test?.tatHours ?? 24), method: test?.method ?? "", aliases: test?.aliases.join(", ") ?? "",
    notes: test?.notes ?? "", active: test?.active ?? true,
  });
  const [params, setParams] = useState<ParamDraft[]>(() => (test ? test.parameters.map(toDraft) : [blankParam()]));
  const [errs, setErrs] = useState<Record<string, string>>({});

  const input = (): TestInput => {
    const taken: string[] = [];
    const ps = params.map((p) => {
      const id = p.isNew ? slug(p.name, taken) : p.id;
      taken.push(id);
      return fromDraft({ ...p, id });
    });
    return {
      code: f.code, name: f.name, section: f.section, sampleType: f.sampleType, price: Math.round((Number(f.price) || 0) * 100), tatHours: Number(f.tatHours) || 24,
      method: f.method, aliases: list(f.aliases), notes: f.notes, active: f.active, parameters: ps,
    };
  };
  const save = useMutation({
    mutationFn: () => (test ? api.updateLabTest(test.id, input()) : api.createLabTest(input())),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["lab-tests"] }); onDone(); },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  const set = (i: number, patch: Partial<ParamDraft>) => setParams((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i: number, d: -1 | 1) => setParams((ps) => {
    const out = [...ps];
    [out[i], out[i + d]] = [out[i + d]!, out[i]!];
    return out;
  });
  const paramErr = (i: number) => Object.entries(errs).filter(([k]) => k.startsWith(`parameters.${i}.`)).map(([k, v]) => `${k.split(".").slice(2).join(" ")}: ${v}`).join(" · ");

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2 className="text-lg font-bold">{test ? `Edit ${test.name}` : "New test"}</h2>
      {test && <p className="text-sm text-ink-3">Changes apply to tests billed from now on. Reports already issued keep the ranges they were issued with.</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Code" value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value.toUpperCase() }))} error={errs.code} hint="e.g. CBC" />
        <Field label="Name" className="sm:col-span-2" value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} error={errs.name} />
        <Field label="Price ₹" inputMode="decimal" value={f.price} onChange={(e) => setF((x) => ({ ...x, price: e.target.value }))} error={errs.price} />
        <Select label="Section" value={f.section} onChange={(e) => setF((x) => ({ ...x, section: LabSection.parse(e.target.value) }))}>
          {LabSection.options.map((s) => <option key={s} value={s}>{LAB_SECTION_LABEL[s]}</option>)}
        </Select>
        <Select label="Sample" value={f.sampleType} onChange={(e) => setF((x) => ({ ...x, sampleType: SampleType.parse(e.target.value) }))}>
          {SampleType.options.map((s) => <option key={s} value={s}>{SAMPLE_LABEL[s]}</option>)}
        </Select>
        <Field label="Report in (hours)" inputMode="numeric" value={f.tatHours} onChange={(e) => setF((x) => ({ ...x, tatHours: e.target.value }))} error={errs.tatHours} />
        <Field label="Method" value={f.method} onChange={(e) => setF((x) => ({ ...x, method: e.target.value }))} />
        <Field label="Other names doctors write" className="sm:col-span-2" value={f.aliases} onChange={(e) => setF((x) => ({ ...x, aliases: e.target.value }))} hint="Comma separated, e.g. RBS, Random sugar" />
        <Field label="Note printed under the test" className="sm:col-span-2" value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} />
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF((x) => ({ ...x, active: e.target.checked }))} /> Offered</label>

      <h3 className="font-semibold">Parameters</h3>
      {errs.parameters && <Alert tone="danger">{errs.parameters}</Alert>}
      <ol className="flex flex-col gap-3">
        {params.map((p, i) => (
          <li key={i} className="flex flex-col gap-3 rounded-lg border border-line p-3">
            <div className="grid items-end gap-3 sm:grid-cols-3 xl:grid-cols-[2fr_1fr_1fr_5rem_1fr_auto]">
              <Field label="Parameter" value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
              <Field label="Unit" value={p.unit} onChange={(e) => set(i, { unit: e.target.value })} />
              <Select label="Result is" value={p.kind} onChange={(e) => set(i, { kind: ParamKind.parse(e.target.value) })}>
                <option value="NUMERIC">A number</option><option value="CHOICE">One of a list</option><option value="TEXT">Text</option>
              </Select>
              <Field label="Decimals" inputMode="numeric" value={p.decimals} disabled={p.kind !== "NUMERIC"} onChange={(e) => set(i, { decimals: e.target.value })} />
              <Field label="Heading" value={p.group} onChange={(e) => set(i, { group: e.target.value })} hint="Optional" />
              <div className="flex gap-1 pb-0.5">
                <Button variant="ghost" className="min-h-9 px-2" aria-label={`Move ${p.name || "parameter"} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp aria-hidden className="size-4" /></Button>
                <Button variant="ghost" className="min-h-9 px-2" aria-label={`Move ${p.name || "parameter"} down`} disabled={i === params.length - 1} onClick={() => move(i, 1)}><ArrowDown aria-hidden className="size-4" /></Button>
                <Button variant="ghost" className="min-h-9 px-2" aria-label={`Remove ${p.name || "parameter"}`} disabled={params.length === 1} onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}><Trash2 aria-hidden className="size-4" /></Button>
              </div>
            </div>
            {p.kind === "NUMERIC" && <Ranges p={p} onChange={(patch) => set(i, patch)} />}
            {p.kind === "CHOICE" && (
              <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                <Field label="Choices" value={p.choices} onChange={(e) => set(i, { choices: e.target.value })} hint="Comma separated, e.g. Negative, Positive" />
                <Field label="Normal answer" value={p.normal} onChange={(e) => set(i, { normal: e.target.value })} hint="Other answers are flagged" />
              </div>
            )}
            {p.kind === "TEXT" && <Field label="Normal answer" value={p.normal} onChange={(e) => set(i, { normal: e.target.value })} hint="Optional; other answers are flagged" />}
            <Field label="Reference text printed instead" value={p.refText} onChange={(e) => set(i, { refText: e.target.value })} hint="Optional, for ranges that need words (e.g. HbA1c)" />
            {paramErr(i) && <p className="text-sm text-danger">{paramErr(i)}</p>}
          </li>
        ))}
      </ol>
      <div><Button onClick={() => setParams((ps) => [...ps, blankParam()])}><Plus aria-hidden className="size-4" /> Add parameter</Button></div>

      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      {Object.keys(errs).length > 0 && <Alert tone="danger">Check the highlighted fields.</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>{test ? "Save changes" : "Add test"}</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function Ranges({ p, onChange }: { p: ParamDraft; onChange: (patch: Partial<ParamDraft>) => void }) {
  const setR = (i: number, patch: Partial<RangeDraft>) => onChange({ ranges: p.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  // What a 35-year-old man and woman would see, as a check on what's been typed.
  const sample = (sex: "M" | "F") => {
    try {
      const param = fromDraft({ ...p, id: "x" }) as Parameter;
      return rangeText({ ...param, refText: "" }, pickRange(param.ranges, sex, 35)) || "none";
    } catch {
      return "—";
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-ink-2">Reference ranges <span className="font-normal text-ink-3">(the closest match for the patient's age and sex is used; leave low or high blank for "up to" / "above")</span></div>
      {p.ranges.map((r, i) => (
        <div key={i} className="grid items-end gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-[8rem_6rem_6rem_1fr_1fr_auto]">
          <Select label="For" value={r.sex} onChange={(e) => setR(i, { sex: RangeSex.parse(e.target.value) })}>
            <option value="ANY">Everyone</option><option value="M">Men / boys</option><option value="F">Women / girls</option>
          </Select>
          <Field label="Age from" inputMode="decimal" value={r.ageFrom} onChange={(e) => setR(i, { ageFrom: e.target.value })} placeholder="any" />
          <Field label="to (under)" inputMode="decimal" value={r.ageTo} onChange={(e) => setR(i, { ageTo: e.target.value })} placeholder="any" />
          <Field label="Low" inputMode="decimal" value={r.low} onChange={(e) => setR(i, { low: e.target.value })} />
          <Field label="High" inputMode="decimal" value={r.high} onChange={(e) => setR(i, { high: e.target.value })} />
          <Button variant="ghost" className="min-h-10 px-2" aria-label="Remove range" onClick={() => onChange({ ranges: p.ranges.filter((_, j) => j !== i) })}><Trash2 aria-hidden className="size-4" /></Button>
        </div>
      ))}
      <div className="grid items-end gap-2 sm:grid-cols-[auto_1fr_1fr]">
        <Button variant="ghost" onClick={() => onChange({ ranges: [...p.ranges, { sex: "ANY", ageFrom: "", ageTo: "", low: "", high: "" }] })}><Plus aria-hidden className="size-4" /> Add range</Button>
        <Field label="Critical below" inputMode="decimal" value={p.criticalLow} onChange={(e) => onChange({ criticalLow: e.target.value })} />
        <Field label="Critical above" inputMode="decimal" value={p.criticalHigh} onChange={(e) => onChange({ criticalHigh: e.target.value })} />
      </div>
      <p className="text-xs text-ink-3">An adult man would see: {sample("M")} · an adult woman: {sample("F")}</p>
    </div>
  );
}
