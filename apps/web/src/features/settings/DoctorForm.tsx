import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";
import { PractitionerInput, SLOT_CHOICES, WEEKDAYS, WEEKDAY_SHORT, type Practitioner, type Session } from "@ojas/shared";
import { api } from "../../lib/api";
import { Alert, Button, Field, Select, cx } from "../../components/ui";
import { formErrors, toPaise, toRupees } from "./forms";

/** Monday first, the way Indian clinics write their timings. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const every = (days: number[], ranges: [string, string][]): Session[] =>
  days.flatMap((weekday) => ranges.map(([start, end]) => ({ weekday, start, end })));

/** One click covers most clinics; the grid below fine-tunes any day. */
const PRESETS: { label: string; sessions: Session[] }[] = [
  { label: "Mon–Sat, 9 am – 1 pm", sessions: every(MON_SAT, [["09:00", "13:00"]]) },
  { label: "Mon–Sat, 9–1 & 5–8 pm", sessions: every(MON_SAT, [["09:00", "13:00"], ["17:00", "20:00"]]) },
  { label: "Mon–Sat, 9 am – 6 pm", sessions: every(MON_SAT, [["09:00", "18:00"]]) },
  { label: "Every day, 8 am – 8 pm", sessions: every(WEEK_ORDER, [["08:00", "20:00"]]) },
];

const sortSessions = (s: Session[]) => [...s].sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) || a.start.localeCompare(b.start));

interface Form {
  name: string; department: string; qualification: string; registrationNo: string; phone: string;
  fee: string; slotMinutes: number; sessions: Session[]; active: boolean;
}

const fromDoctor = (d?: Practitioner): Form => ({
  name: d?.name ?? "Dr. ",
  department: d?.department ?? "",
  qualification: d?.qualification ?? "",
  registrationNo: d?.registrationNo ?? "",
  phone: d?.phone ?? "",
  fee: d ? toRupees(d.consultationFee) : "",
  slotMinutes: d?.slotMinutes ?? 10,
  sessions: d ? sortSessions(d.sessions) : PRESETS[1]!.sessions,
  active: d?.active ?? true,
});

/** Add or edit a doctor: details, fee, slot length and the weekly consulting timetable. */
export function DoctorForm({ doctor, onSaved, onCancel }: { doctor?: Practitioner; onSaved: (d: Practitioner) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => fromDoctor(doctor));
  const [errs, setErrs] = useState<Record<string, string>>({});

  const input = (): PractitionerInput => ({
    name: form.name, department: form.department, qualification: form.qualification, registrationNo: form.registrationNo, phone: form.phone,
    consultationFee: toPaise(form.fee), slotMinutes: form.slotMinutes, sessions: form.sessions, active: form.active,
  });

  const save = useMutation({
    mutationFn: (v: PractitionerInput) => (doctor ? api.updatePractitioner(doctor.id, v) : api.createPractitioner(v)),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ["settings-practitioners"] });
      void qc.invalidateQueries({ queryKey: ["practitioners"] });
      void qc.invalidateQueries({ queryKey: ["slots"] });
      onSaved(d);
    },
    onError: (e) => setErrs(formErrors(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.fee !== "" && !/^\d+(\.\d{1,2})?$/.test(form.fee)) return setErrs({ consultationFee: "Enter the fee in rupees, like 500" });
    if (form.fee === "") return setErrs({ consultationFee: "Enter the consultation fee (0 if free)" });
    const parsed = PractitionerInput.safeParse(input());
    if (!parsed.success) return setErrs(formErrors(parsed.error));
    setErrs({});
    save.mutate(input());
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const text = (k: "name" | "department" | "qualification" | "registrationNo" | "phone" | "fee") => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value);
  const scheduleError = errs.sessions ?? Object.entries(errs).find(([k]) => k.startsWith("sessions."))?.[1];

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Doctor's name" autoFocus value={form.name} onChange={text("name")} error={errs.name} />
        <Field label="Department / speciality" value={form.department} onChange={text("department")} error={errs.department} placeholder="e.g. General Medicine" list="ojas-departments" />
        <Field label="Qualification (optional)" value={form.qualification} onChange={text("qualification")} error={errs.qualification} placeholder="e.g. MBBS, MD" />
        <Field label="Consultation fee (₹)" inputMode="decimal" value={form.fee} onChange={text("fee")} error={errs.consultationFee} placeholder="500" />
        <Select label="Time per patient" value={form.slotMinutes} onChange={(e) => set("slotMinutes", Number(e.target.value))} error={errs.slotMinutes}>
          {SLOT_CHOICES.map((m) => <option key={m} value={m}>{m} minutes</option>)}
        </Select>
        <Field label="Registration no. (optional)" value={form.registrationNo} onChange={text("registrationNo")} error={errs.registrationNo} hint="Medical council number" />
        <Field label="Phone (optional)" inputMode="tel" value={form.phone} onChange={text("phone")} error={errs.phone} />
      </div>
      <datalist id="ojas-departments">
        {["General Medicine", "Paediatrics", "Gynaecology", "Orthopaedics", "Dermatology", "ENT", "Ophthalmology", "Cardiology", "Dentistry", "Psychiatry", "General Surgery"].map((d) => <option key={d} value={d} />)}
      </datalist>

      <ScheduleEditor sessions={form.sessions} onChange={(s) => set("sessions", s)} errors={errs} slotMinutes={form.slotMinutes} />
      {scheduleError && <Alert tone="danger">{scheduleError}</Alert>}

      {doctor && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active. Untick to hide this doctor from the front desk (their past visits and bills stay).
        </label>
      )}
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : doctor ? "Save changes" : "Add doctor"}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

/** The weekly timetable: up to 3 sessions per day (morning, afternoon, evening clinics). */
function ScheduleEditor({ sessions, onChange, errors, slotMinutes }: { sessions: Session[]; onChange: (s: Session[]) => void; errors: Record<string, string>; slotMinutes: number }) {
  const indexed = sessions.map((s, i) => ({ ...s, i }));
  const update = (i: number, patch: Partial<Session>) => onChange(sessions.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onChange(sessions.filter((_, k) => k !== i));
  const add = (weekday: number) => {
    const day = sessions.filter((s) => s.weekday === weekday).sort((a, b) => a.start.localeCompare(b.start));
    const last = day[day.length - 1];
    const next = last ? { start: last.end < "17:00" ? "17:00" : last.end, end: last.end < "17:00" ? "20:00" : "21:00" } : { start: "09:00", end: "13:00" };
    onChange(sortSessions([...sessions, { weekday, ...next }]));
  };
  const copyToWeek = (from: number) => {
    const src = sessions.filter((s) => s.weekday === from);
    onChange(sortSessions([...sessions.filter((s) => !MON_SAT.includes(s.weekday)), ...MON_SAT.flatMap((weekday) => src.map((s) => ({ ...s, weekday })))]));
  };
  const totalSlots = sessions.reduce((n, s) => {
    const mins = (Number(s.end.slice(0, 2)) * 60 + Number(s.end.slice(3))) - (Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3)));
    return n + Math.max(0, Math.floor(mins / slotMinutes));
  }, 0);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-ink-2">Consulting hours</legend>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-3">Quick fill:</span>
        {PRESETS.map((p) => (
          <Button key={p.label} variant="secondary" className="min-h-8 text-xs" onClick={() => onChange(p.sessions)}>{p.label}</Button>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        {WEEK_ORDER.map((d) => {
          const day = indexed.filter((s) => s.weekday === d);
          return (
            <div key={d} className={cx("flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-0", !day.length && "bg-surface-2/60")}>
              <span className="w-12 shrink-0 font-semibold" title={WEEKDAYS[d]}>{WEEKDAY_SHORT[d]}</span>
              {!day.length && <span className="text-sm text-ink-3">Not consulting</span>}
              {day.map((s) => {
                const err = errors[`sessions.${s.i}.start`] ?? errors[`sessions.${s.i}.end`];
                return (
                  <span key={s.i} className={cx("flex items-center gap-1 rounded-md border px-1.5 py-1", err ? "border-danger" : "border-line")} title={err}>
                    <input type="time" aria-label={`${WEEKDAYS[d]} session start`} value={s.start} step={300} onChange={(e) => update(s.i, { start: e.target.value })} className="rounded bg-transparent px-1 text-sm tabular-nums" />
                    <span aria-hidden className="text-ink-3">–</span>
                    <input type="time" aria-label={`${WEEKDAYS[d]} session end`} value={s.end} step={300} onChange={(e) => update(s.i, { end: e.target.value })} className="rounded bg-transparent px-1 text-sm tabular-nums" />
                    <button type="button" onClick={() => remove(s.i)} aria-label={`Remove ${WEEKDAYS[d]} ${s.start} session`} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-danger">
                      <Trash2 aria-hidden className="size-3.5" />
                    </button>
                  </span>
                );
              })}
              <span className="ml-auto flex gap-1">
                {day.length < 3 && (
                  <Button variant="ghost" className="min-h-8 text-xs" onClick={() => add(d)} aria-label={`Add a session on ${WEEKDAYS[d]}`}>
                    <Plus aria-hidden className="size-3.5" /> {day.length ? "Session" : "Add hours"}
                  </Button>
                )}
                {d === 1 && day.length > 0 && (
                  <Button variant="ghost" className="min-h-8 text-xs" onClick={() => copyToWeek(1)}>
                    <Copy aria-hidden className="size-3.5" /> Copy to Tue–Sat
                  </Button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-sm text-ink-3">{totalSlots} appointment slots a week at {slotMinutes} minutes each.</p>
    </fieldset>
  );
}
