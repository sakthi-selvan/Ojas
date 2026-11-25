import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { bmiOf, VITAL_KEYS, type Encounter, type Vitals, type VitalsInput } from "@ojas/shared";
import { api, ApiError, timeLabel } from "../../lib/api";
import { Alert, Button, cx } from "../../components/ui";

export type VitalKey = (typeof VITAL_KEYS)[number];
type Key = VitalKey;
export const VITAL_FIELDS: { key: Key; label: string; unit: string; step: string; width?: string }[] = [
  { key: "temperatureF", label: "Temp", unit: "°F", step: "0.1" },
  { key: "pulse", label: "Pulse", unit: "/min", step: "1" },
  { key: "bpSystolic", label: "BP sys", unit: "mmHg", step: "1" },
  { key: "bpDiastolic", label: "BP dia", unit: "mmHg", step: "1" },
  { key: "spo2", label: "SpO₂", unit: "%", step: "1" },
  { key: "respRate", label: "Resp", unit: "/min", step: "1" },
  { key: "weightKg", label: "Weight", unit: "kg", step: "0.1" },
  { key: "heightCm", label: "Height", unit: "cm", step: "0.1" },
  { key: "bloodSugar", label: "Sugar (RBS)", unit: "mg/dL", step: "1" },
];

export type VitalsFormState = Record<Key, string>;
type Form = VitalsFormState;
export const toVitalsForm = (v?: Vitals): Form => Object.fromEntries(VITAL_KEYS.map((k) => [k, v?.[k] == null ? "" : String(v[k])])) as Form;
export const toVitalsInput = (f: Form): VitalsInput => Object.fromEntries(VITAL_KEYS.map((k) => [k, f[k].trim() === "" ? null : Number(f[k])])) as VitalsInput;

/** Out-of-range readings get a coloured hint, so the doctor's eye goes to them first. */
export function vitalFlag(key: Key, n: number): "high" | "low" | null {
  const ranges: Partial<Record<Key, [number, number]>> = {
    temperatureF: [97, 99.5], pulse: [60, 100], bpSystolic: [90, 139], bpDiastolic: [60, 89], spo2: [95, 100], respRate: [12, 20], bloodSugar: [70, 199],
  };
  const r = ranges[key];
  if (!r) return null;
  return n > r[1] ? "high" : n < r[0] ? "low" : null;
}

/**
 * Vitals for one visit. The nurse fills it at triage (from the queue); the doctor sees and can
 * correct it on the consultation screen. Saved on its own, so it never overwrites the doctor's notes.
 */
export function VitalsForm({ appointmentId, encounter, readOnly, onSaved, autoFocus }: {
  appointmentId: string;
  encounter: Encounter | null;
  readOnly?: boolean;
  onSaved?: (e: Encounter) => void;
  autoFocus?: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(() => toVitalsForm(encounter?.vitals));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  // After the surrounding dialog has opened (opening a dialog moves focus to its first button).
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => first.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [autoFocus]);
  const save = useMutation({
    mutationFn: () => api.saveVitals(appointmentId, toVitalsInput(form)),
    onSuccess: (e) => {
      setErrs({});
      setSavedAt(new Date().toISOString());
      qc.setQueryData(["consult", appointmentId], (v: unknown) => (v ? { ...(v as object), encounter: e } : v));
      void qc.invalidateQueries({ queryKey: ["queue"] });
      onSaved?.(e);
    },
    onError: (e) => setErrs(e instanceof ApiError ? e.fields : {}),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const bmi = bmiOf({ heightCm: Number(form.heightCm) || null, weightKg: Number(form.weightKg) || null });
  const dirty = JSON.stringify(form) !== JSON.stringify(toVitalsForm(encounter?.vitals));

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Vitals">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">
        {VITAL_FIELDS.map((f, i) => {
          const n = form[f.key] === "" ? null : Number(form[f.key]);
          const fl = n == null || Number.isNaN(n) ? null : vitalFlag(f.key, n);
          const id = `v-${appointmentId}-${f.key}`;
          return (
            <div key={f.key} className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={id} className="truncate text-xs font-medium text-ink-2">{f.label}</label>
              <div className="relative">
                <input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  step={f.step}
                  ref={i === 0 ? first : undefined}
                  readOnly={readOnly}
                  value={form[f.key]}
                  aria-invalid={errs[f.key] ? true : undefined}
                  aria-describedby={errs[f.key] ? `${id}-err` : undefined}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  className={cx(
                    "min-h-10 w-full rounded-lg border bg-surface py-1 pl-2 pr-9 text-base tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
                    errs[f.key] ? "border-danger" : "border-line",
                    fl === "high" && "text-danger font-semibold",
                    fl === "low" && "text-warn font-semibold",
                    readOnly && "bg-surface-2",
                  )}
                />
                <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-3">{f.unit}</span>
              </div>
              {errs[f.key] && <span id={`${id}-err`} className="text-xs text-danger">{errs[f.key]}</span>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-2">BMI <strong className="tabular-nums text-ink">{bmi ?? "—"}</strong></span>
        {encounter?.vitalsRecordedAt && (
          <span className="text-ink-3">Recorded by {encounter.vitalsRecordedBy} at {timeLabel(encounter.vitalsRecordedAt)}</span>
        )}
        {!readOnly && (
          <Button type="submit" variant={dirty ? "primary" : "secondary"} className="ml-auto" disabled={save.isPending || !dirty}>
            {save.isPending ? "Saving…" : savedAt && !dirty ? "Saved" : "Save vitals"}
          </Button>
        )}
      </div>
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
    </form>
  );
}
