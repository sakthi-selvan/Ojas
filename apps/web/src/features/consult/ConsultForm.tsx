import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PenLine, Plus, Printer, RotateCcw, Trash2, X } from "lucide-react";
import {
  ageLabel, FREQUENCIES, MED_TIMING_LABEL, MedTiming, type ConsultNotesInput, type ConsultView, type Diagnosis, type Encounter,
  type LabOrder, type Medication, type Suggestion,
} from "@ojas/shared";
import { api, ApiError, dateLabel, dateTimeLabel, timeLabel } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Card, cx } from "../../components/ui";
import { SuggestInput } from "./SuggestInput";
import { VitalsForm } from "./VitalsForm";
import { localDay, medLine, PrintablePrescription, printPrescription } from "./Prescription";
import { PastVisits } from "./PastVisits";

interface Notes {
  chiefComplaint: string; history: string; examination: string; advice: string; followUpDate: string;
  diagnoses: Diagnosis[]; medications: Medication[]; labOrders: LabOrder[];
}

const fromEncounter = (e: Encounter | null): Notes => ({
  chiefComplaint: e?.chiefComplaint ?? "", history: e?.history ?? "", examination: e?.examination ?? "", advice: e?.advice ?? "",
  followUpDate: e?.followUpDate ?? "", diagnoses: e?.diagnoses ?? [], medications: e?.medications ?? [], labOrders: e?.labOrders ?? [],
});

const emptyMed = (drug = ""): Medication => ({ drug, dose: "", frequency: "", timing: "AFTER_FOOD", durationDays: null, instructions: "" });

/** Rows the doctor started but left blank are dropped on save instead of failing validation. */
const toInput = (n: Notes, notesVersion: number): ConsultNotesInput => ({
  ...n,
  followUpDate: n.followUpDate || null,
  medications: n.medications.filter((m) => m.drug.trim()),
  notesVersion,
});

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

/** The doctor's screen for one patient: writes as they type, then sign (and print) when done. */
export function ConsultForm({ view, onNext }: { view: ConsultView; onNext?: () => void }) {
  const e = view.encounter;
  if (e?.status === "SIGNED") return <SignedConsult view={view} encounter={e} onNext={onNext} />;
  return <DraftConsult view={view} onNext={onNext} />;
}

/** The form, with the patient's earlier visits beside it on wide screens (below it on narrow ones). */
function Layout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid items-start gap-4 2xl:grid-cols-[1fr_22rem]">
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      <aside className="min-w-0 2xl:sticky 2xl:top-20">{aside}</aside>
    </div>
  );
}

function PatientHeader({ view, right }: { view: ConsultView; right?: React.ReactNode }) {
  const p = view.patient;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <div className="grid size-11 place-items-center rounded-lg bg-surface-2 text-xl font-bold tabular-nums" aria-label={`Token ${view.token}`}>{view.token}</div>
      <div className="min-w-0">
        <h2 className="truncate text-lg font-bold">{p.name}</h2>
        <div className="text-sm text-ink-2">
          {p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : "Other"}, {ageLabel(p.dob)}{p.dobEstimated ? " (approx.)" : ""} · {p.uhid} · {p.phone} · {timeLabel(view.slotStart)}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">{right}</div>
    </div>
  );
}

function DraftConsult({ view, onNext }: { view: ConsultView; onNext?: () => void }) {
  const qc = useQueryClient();
  const id = view.appointmentId;
  const [notes, setNotes] = useState<Notes>(() => fromEncounter(view.encounter));
  const version = useRef(view.encounter?.notesVersion ?? 0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const latest = useRef(notes);
  latest.current = notes;
  const inFlight = useRef<Promise<boolean> | null>(null);
  const dirty = useRef(false);
  const drugRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusDrug = useRef<number | null>(null);

  /** One save at a time; changes made during a save go out right after it. Resolves false on failure. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    if (!dirty.current) return true;
    dirty.current = false;
    setSaveState("saving");
    const run = (async () => {
      try {
        const enc = await api.saveNotes(id, toInput(latest.current, version.current));
        version.current = enc.notesVersion;
        qc.setQueryData(["consult", id], (v: ConsultView | undefined) => (v ? { ...v, encounter: enc } : v));
        setError(null);
        setFieldErrors({});
        setSaveState(dirty.current ? "pending" : "saved");
        return true;
      } catch (err) {
        dirty.current = true;
        setSaveState("error");
        setError((err as Error).message);
        setFieldErrors(err instanceof ApiError ? err.fields : {});
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    if (ok && dirty.current) return flush();
    return ok;
  }, [id, qc]);

  // Save about a second after the doctor stops typing.
  const update = (fn: (n: Notes) => Notes) => {
    setNotes((n) => fn(n));
    dirty.current = true;
    setSaveState("pending");
  };
  useEffect(() => {
    if (saveState !== "pending") return;
    const t = setTimeout(() => void flush(), 1000);
    return () => clearTimeout(t);
  }, [notes, saveState, flush]);
  // Don't lose the last keystrokes when switching patient.
  useEffect(() => () => void (dirty.current && flush()), [flush]);

  useEffect(() => {
    if (focusDrug.current != null) {
      drugRefs.current[focusDrug.current]?.focus();
      focusDrug.current = null;
    }
  });

  const sign = useMutation({
    mutationFn: async (print: boolean) => {
      if (!(await flush())) throw new Error("Fix the highlighted items, then sign again");
      const enc = await api.signConsult(id);
      return { enc, print };
    },
    onSuccess: ({ enc, print }) => {
      qc.setQueryData(["consult", id], (v: ConsultView | undefined) => (v ? { ...v, encounter: enc, appointmentStatus: "DONE" } : v));
      void qc.invalidateQueries({ queryKey: ["queue"] });
      if (print) setTimeout(() => void printPrescription(), 50);
    },
  });

  const addMedicine = (s?: Suggestion) =>
    update((n) => {
      focusDrug.current = n.medications.length;
      return { ...n, medications: [...n.medications, s ? { ...emptyMed(s.text), ...s.med } : emptyMed()] };
    });
  const setMed = (i: number, patch: Partial<Medication>) =>
    update((n) => ({ ...n, medications: n.medications.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  useHotkeys({
    "Ctrl+Enter": () => !sign.isPending && sign.mutate(true),
    "Ctrl+S": () => void flush(),
    "Alt+M": () => addMedicine(),
  });

  const visitDate = localDay(view.slotStart);
  const enc = view.encounter;
  const textArea = (key: "chiefComplaint" | "history" | "examination" | "advice", label: string, rows: number, placeholder?: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium text-ink-2">{label}</label>
      <textarea
        id={`${id}-${key}`}
        rows={rows}
        placeholder={placeholder}
        value={notes[key]}
        onChange={(ev) => update((n) => ({ ...n, [key]: ev.target.value }))}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-3"
      />
    </div>
  );

  const repeat = (meds: Medication[]) =>
    update((n) => {
      const have = new Set(n.medications.map((m) => m.drug.trim().toLowerCase()));
      return { ...n, medications: [...n.medications.filter((m) => m.drug.trim()), ...meds.filter((m) => !have.has(m.drug.toLowerCase()))] };
    });

  return (
    <Layout aside={<PastVisits appointmentId={id} onRepeat={repeat} />}>
      <Card className="flex flex-col gap-4 p-4">
        <PatientHeader
          view={view}
          right={<>
            {enc?.reopenReason && <Badge tone="warn">Correcting: {enc.reopenReason}</Badge>}
            <SaveIndicator state={saveState} />
          </>}
        />
        <div>
          <h3 className="mb-2 text-sm font-semibold">Vitals</h3>
          <VitalsForm key={enc?.vitalsRecordedAt ?? "none"} appointmentId={id} encounter={enc} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        {textArea("chiefComplaint", "Complaints", 2, "e.g. Fever and sore throat for 3 days")}
        <div className="grid gap-4 lg:grid-cols-2">
          {textArea("history", "History", 3, "Past illness, allergies, current medicines")}
          {textArea("examination", "Examination", 3, "Findings")}
        </div>

        <ChipList
          label="Diagnosis"
          kind="diagnosis"
          items={notes.diagnoses.map((d) => ({ text: d.text, sub: d.code }))}
          onAdd={(s) => update((n) => ({ ...n, diagnoses: [...n.diagnoses, { text: s.text, code: s.code ?? "" }] }))}
          onRemove={(i) => update((n) => ({ ...n, diagnoses: n.diagnoses.filter((_, j) => j !== i) }))}
          placeholder="Type a diagnosis, Enter to add"
        />
      </Card>

      <Card className="flex flex-col gap-3 p-4" aria-labelledby={`${id}-rx`}>
        <div className="flex items-center gap-2">
          <h3 id={`${id}-rx`} className="font-semibold">Medicines</h3>
          <Button variant="ghost" className="ml-auto" onClick={() => addMedicine()} shortcut="Alt+M">
            <Plus aria-hidden className="size-4" /> Add medicine
          </Button>
        </div>
        {notes.medications.length === 0 && <p className="text-sm text-ink-3">No medicines yet. Press Alt+M, or repeat an earlier prescription from the patient's history.</p>}
        <datalist id="ojas-frequencies">{FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
        <ol className="flex flex-col gap-3">
          {notes.medications.map((m, i) => (
            <li key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-line p-2 sm:grid-cols-6 xl:grid-cols-[minmax(12rem,2fr)_7rem_7rem_9rem_5rem_minmax(8rem,1fr)_auto]">
              <SuggestInput
                ref={(el) => { drugRefs.current[i] = el; }}
                kind="drug"
                label={`Medicine ${i + 1}`}
                className="col-span-2 sm:col-span-6 xl:col-span-1"
                value={m.drug}
                placeholder="Name and form, e.g. Tab. Paracetamol"
                onChange={(drug) => setMed(i, { drug })}
                onPick={(s) => setMed(i, { drug: s.text, ...(s.med && !m.dose && !m.frequency ? s.med : {}) })}
              />
              <SmallField label="Dose" value={m.dose} onChange={(dose) => setMed(i, { dose })} placeholder="500 mg" />
              <SmallField label="When" value={m.frequency} onChange={(frequency) => setMed(i, { frequency })} placeholder="1-0-1" list="ojas-frequencies" />
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-t${i}`} className="text-xs font-medium text-ink-2">Food</label>
                <select id={`${id}-t${i}`} value={m.timing} onChange={(ev) => setMed(i, { timing: MedTiming.parse(ev.target.value) })} className="min-h-10 rounded-lg border border-line bg-surface px-2 text-sm">
                  {MedTiming.options.map((t) => <option key={t} value={t}>{MED_TIMING_LABEL[t] || "Any time"}</option>)}
                </select>
              </div>
              <SmallField
                label="Days"
                type="number"
                value={m.durationDays == null ? "" : String(m.durationDays)}
                onChange={(d) => setMed(i, { durationDays: d === "" ? null : Math.max(1, Math.min(365, Math.round(Number(d)))) })}
                placeholder="—"
                error={fieldErrors[`medications.${i}.durationDays`]}
              />
              <SmallField label="Notes" value={m.instructions} onChange={(instructions) => setMed(i, { instructions })} placeholder="optional" />
              <Button variant="ghost" aria-label={`Remove ${m.drug || `medicine ${i + 1}`}`} onClick={() => update((n) => ({ ...n, medications: n.medications.filter((_, j) => j !== i) }))}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
              {fieldErrors[`medications.${i}.drug`] && <p className="col-span-full text-sm text-danger">{fieldErrors[`medications.${i}.drug`]}</p>}
            </li>
          ))}
        </ol>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <ChipList
          label="Tests"
          kind="lab"
          items={notes.labOrders.map((l) => ({ text: l.test, sub: l.notes }))}
          onAdd={(s) => update((n) => ({ ...n, labOrders: [...n.labOrders, { test: s.text, notes: "" }] }))}
          onRemove={(i) => update((n) => ({ ...n, labOrders: n.labOrders.filter((_, j) => j !== i) }))}
          placeholder="e.g. CBC, Lipid profile"
        />
        {textArea("advice", "Advice", 3, "Diet, rest, warning signs")}
        <fieldset className="flex flex-wrap items-end gap-2">
          <legend className="mb-1 text-sm font-medium text-ink-2">Review on</legend>
          <input
            type="date"
            aria-label="Review date"
            min={visitDate}
            value={notes.followUpDate}
            onChange={(ev) => update((n) => ({ ...n, followUpDate: ev.target.value }))}
            className="min-h-10 rounded-lg border border-line bg-surface px-3 text-base"
          />
          {([["3 days", 3], ["1 week", 7], ["2 weeks", 14], ["1 month", 30]] as const).map(([label, days]) => (
            <Button key={label} variant="ghost" aria-pressed={notes.followUpDate === addDays(visitDate, days)} onClick={() => update((n) => ({ ...n, followUpDate: addDays(visitDate, days) }))}>
              {label}
            </Button>
          ))}
          {notes.followUpDate && (
            <Button variant="ghost" onClick={() => update((n) => ({ ...n, followUpDate: "" }))}>No review</Button>
          )}
        </fieldset>
      </Card>

      {(error || sign.error) && <Alert tone="danger">{sign.error?.message ?? error}</Alert>}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
        <Button variant="primary" size="lg" onClick={() => sign.mutate(true)} disabled={sign.isPending} shortcut="Ctrl+Enter">
          <CheckCircle2 aria-hidden className="size-5" /> {sign.isPending ? "Signing…" : "Sign & print"}
        </Button>
        <Button size="lg" onClick={() => sign.mutate(false)} disabled={sign.isPending}>Sign only</Button>
        <span className="text-sm text-ink-3">Signing locks the record and marks the visit done.</span>
        {onNext && <Button variant="ghost" className="ml-auto" onClick={onNext} shortcut="Alt+N">Next patient</Button>}
      </div>
    </Layout>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text = { idle: "", pending: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Not saved" }[state];
  if (!text) return null;
  return <span role="status" className={cx("text-sm", state === "error" ? "font-semibold text-danger" : state === "saved" ? "text-ok" : "text-ink-3")}>{text}</span>;
}

function SmallField({ label, value, onChange, placeholder, list, type = "text", error }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; list?: string; type?: string; error?: string;
}) {
  const fid = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={fid} className="text-xs font-medium text-ink-2">{label}</label>
      <input
        id={fid}
        type={type}
        list={list}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cx("min-h-10 w-full rounded-lg border bg-surface px-2 text-sm placeholder:text-ink-3", error ? "border-danger" : "border-line")}
      />
    </div>
  );
}

/** Diagnoses and tests: a list of chips plus a suggestion box that adds on Enter. */
function ChipList({ label, kind, items, onAdd, onRemove, placeholder }: {
  label: string;
  kind: "diagnosis" | "lab";
  items: { text: string; sub?: string }[];
  onAdd: (s: Suggestion) => void;
  onRemove: (i: number) => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <SuggestInput
        kind={kind}
        label={label}
        value={text}
        onChange={setText}
        placeholder={placeholder}
        onPick={(s) => {
          if (!items.some((x) => x.text.toLowerCase() === s.text.toLowerCase())) onAdd(s);
          setText("");
        }}
      />
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={label}>
          {items.map((x, i) => (
            <li key={x.text + i} className="flex items-center gap-1 rounded-full bg-accent-soft py-1 pl-3 pr-1 text-sm font-medium text-accent">
              {x.text}
              {x.sub && <span className="text-xs opacity-70">{x.sub}</span>}
              <button type="button" aria-label={`Remove ${x.text}`} onClick={() => onRemove(i)} className="grid size-6 place-items-center rounded-full hover:bg-surface">
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A signed record: read-only, printable, and correctable with a reason. */
function SignedConsult({ view, encounter: e, onNext }: { view: ConsultView; encounter: Encounter; onNext?: () => void }) {
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const reopen = useMutation({
    mutationFn: () => api.reopenConsult(view.appointmentId, reason),
    onSuccess: (enc) => {
      dialog.current?.close();
      setReason("");
      qc.setQueryData(["consult", view.appointmentId], (v: ConsultView | undefined) => (v ? { ...v, encounter: enc } : v));
    },
  });
  useHotkeys({ P: () => void printPrescription() });
  const v = e.vitals;
  const vitals = [
    v.temperatureF != null && `Temp ${v.temperatureF} °F`, v.pulse != null && `Pulse ${v.pulse}`,
    v.bpSystolic != null && v.bpDiastolic != null && `BP ${v.bpSystolic}/${v.bpDiastolic}`, v.spo2 != null && `SpO₂ ${v.spo2}%`,
    v.weightKg != null && `Wt ${v.weightKg} kg`,
  ].filter(Boolean);

  return (
    <Layout aside={<PastVisits appointmentId={view.appointmentId} />}>
      <Card className="flex flex-col gap-4 p-4">
        <PatientHeader view={view} right={<Badge tone="ok"><CheckCircle2 aria-hidden className="size-3.5" /> Signed</Badge>} />
        <div role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
          Signed by {e.signedBy} on {e.signedAt ? dateTimeLabel(e.signedAt) : ""}{e.version > 1 ? ` · version ${e.version} (corrected)` : ""}
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          {vitals.length > 0 && <><dt className="text-ink-3">Vitals</dt><dd>{vitals.join(" · ")}</dd></>}
          {e.chiefComplaint && <><dt className="text-ink-3">Complaints</dt><dd>{e.chiefComplaint}</dd></>}
          {e.history && <><dt className="text-ink-3">History</dt><dd className="whitespace-pre-line">{e.history}</dd></>}
          {e.examination && <><dt className="text-ink-3">Examination</dt><dd className="whitespace-pre-line">{e.examination}</dd></>}
          {e.diagnoses.length > 0 && <><dt className="text-ink-3">Diagnosis</dt><dd>{e.diagnoses.map((d) => d.text + (d.code ? ` (${d.code})` : "")).join("; ")}</dd></>}
          {e.medications.length > 0 && (
            <><dt className="text-ink-3">Medicines</dt><dd><ol className="list-decimal pl-5">{e.medications.map((m, i) => <li key={i}><strong>{m.drug}</strong> · {medLine(m)}{m.instructions ? ` · ${m.instructions}` : ""}</li>)}</ol></dd></>
          )}
          {e.labOrders.length > 0 && <><dt className="text-ink-3">Tests</dt><dd>{e.labOrders.map((l) => l.test).join(", ")}</dd></>}
          {e.advice && <><dt className="text-ink-3">Advice</dt><dd className="whitespace-pre-line">{e.advice}</dd></>}
          {e.followUpDate && <><dt className="text-ink-3">Review on</dt><dd>{dateLabel(e.followUpDate)}</dd></>}
        </dl>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" onClick={() => void printPrescription()} shortcut="P"><Printer aria-hidden className="size-5" /> Print prescription</Button>
        <Button size="lg" onClick={() => dialog.current?.showModal()}><PenLine aria-hidden className="size-4" /> Correct</Button>
        {onNext && <Button variant="ghost" size="lg" className="ml-auto" onClick={onNext} shortcut="Alt+N">Next patient</Button>}
      </div>
      <PrintablePrescription view={view} encounter={e} />
      <dialog ref={dialog} aria-labelledby="reopen-h" className="m-auto w-full max-w-md rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/50">
        <form method="dialog" onSubmit={(ev) => { ev.preventDefault(); reopen.mutate(); }} className="flex flex-col gap-3">
          <h2 id="reopen-h" className="flex items-center gap-2 text-lg font-bold"><RotateCcw aria-hidden className="size-5" /> Correct this consultation</h2>
          <p className="text-sm text-ink-2">The signed version stays on record. Your reason is kept with the corrected version.</p>
          <label htmlFor="reopen-reason" className="text-sm font-medium text-ink-2">What needs correcting?</label>
          <textarea id="reopen-reason" rows={3} value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus className="rounded-lg border border-line bg-surface px-3 py-2 text-base" />
          {reopen.error && <Alert tone="danger">{reopen.error.message}</Alert>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => dialog.current?.close()}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={reopen.isPending}>Open for correction</Button>
          </div>
        </form>
      </dialog>
    </Layout>
  );
}
