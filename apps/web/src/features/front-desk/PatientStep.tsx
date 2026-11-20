import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, UserPlus, Phone } from "lucide-react";
import { ageLabel, type Patient, type PatientSearchResult, type Sex } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Badge, Button, Field, Kbd, Segmented, cx } from "../../components/ui";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const looksLikePhone = (q: string) => /^[\d\s+-]{3,}$/.test(q.trim());

/**
 * Step 1: find or register the patient. One box; the receptionist types whatever the patient
 * says (phone, name, UHID). ↑/↓ + Enter picks a match; Alt+N (or Enter on "no match") opens the
 * 4-field registration, prefilled with what was already typed.
 */
export function PatientStep({ onSelect }: { onSelect: (p: Patient) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [registering, setRegistering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q.trim(), 150);

  const results = useQuery({
    queryKey: ["patients", dq],
    queryFn: () => api.searchPatients(dq),
    enabled: dq.length >= 2 && !registering,
    placeholderData: (prev) => prev,
  });
  const list: PatientSearchResult[] = dq.length >= 2 ? (results.data ?? []) : [];

  useEffect(() => setActive(0), [dq]);
  useHotkeys({
    "Alt+N": () => setRegistering(true),
    "Ctrl+K": () => {
      setRegistering(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  });

  if (registering) {
    return (
      <RegisterForm
        initial={q}
        onCancel={() => {
          setRegistering(false);
          setTimeout(() => inputRef.current?.focus());
        }}
        onDone={onSelect}
      />
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = list[active];
      if (hit) onSelect(hit);
      else if (dq.length >= 2 && !results.isFetching) setRegistering(true);
    }
  };

  const noMatch = dq.length >= 2 && results.isSuccess && !results.isFetching && list.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-3" />
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded={list.length > 0}
          aria-controls="patient-results"
          aria-activedescendant={list[active] ? `pr-${list[active].id}` : undefined}
          aria-label="Search patient by phone, name or UHID"
          placeholder="Phone, name or UHID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-14 w-full rounded-xl border border-line bg-surface pl-11 pr-24 text-lg text-ink placeholder:text-ink-3"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3">
          <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
        </span>
      </div>

      {list.length > 0 && (
        <ul id="patient-results" role="listbox" aria-label="Matching patients" className="flex flex-col gap-1">
          {list.map((p, i) => (
            <li
              key={p.id}
              id={`pr-${p.id}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => onSelect(p)}
              className={cx(
                "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5",
                i === active ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2",
              )}
            >
              <div className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-bold text-ink-2" aria-hidden>
                {p.name.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {p.name} <span className="font-normal text-ink-2">· {p.sex} · {p.dobEstimated ? "~" : ""}{ageLabel(p.dob)}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-ink-2">
                  <Phone aria-hidden className="size-3.5" /> {p.phone} <span aria-hidden>·</span> {p.uhid}
                </div>
              </div>
              {p.lastVisitAt ? <Badge>Last visit {new Date(p.lastVisitAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</Badge> : <Badge tone="accent">New</Badge>}
              {i === active && <Kbd className="text-accent">Enter</Kbd>}
            </li>
          ))}
        </ul>
      )}

      {noMatch && (
        <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-2" role="status">
          No patient found for “{dq}”. Press <Kbd>Enter</Kbd> to register them.
        </p>
      )}
      {results.error && <Alert tone="danger">{(results.error as Error).message}</Alert>}

      <div>
        <Button onClick={() => setRegistering(true)} shortcut="Alt+N">
          <UserPlus aria-hidden className="size-4" /> New patient
        </Button>
      </div>
    </div>
  );
}

/** "42" → age 42 y · "6m" → 6 months · "12/05/1983" or "1983-05-12" → date of birth. */
function parseAgeOrDob(raw: string): { ageYears?: number; dob?: string } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d{1,3})\s*(y|yr|yrs|years?)?$/);
  if (m) return { ageYears: Number(m[1]) };
  m = s.match(/^(\d{1,2})\s*(m|mo|months?)$/);
  if (m) {
    const d = new Date();
    d.setMonth(d.getMonth() - Number(m[1]));
    return { dob: isoDate(d) };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return { dob: `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { dob: s };
  return null;
}
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function RegisterForm({ initial, onDone, onCancel }: { initial: string; onDone: (p: Patient) => void; onCancel: () => void }) {
  const prefill = useMemo(() => (looksLikePhone(initial) ? { phone: initial.trim(), name: "" } : { phone: "", name: initial.trim() }), [initial]);
  const [name, setName] = useState(prefill.name);
  const [phone, setPhone] = useState(prefill.phone);
  const [age, setAge] = useState("");
  const [sex, setSex] = useState<Sex>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<Patient>();

  const register = useMutation({
    mutationFn: (force: boolean) => {
      const a = parseAgeOrDob(age);
      return api.registerPatient({ name, phone, sex: sex!, ...(a ?? {}) }, force);
    },
    onSuccess: onDone,
    onError: (e) => {
      if (e instanceof ApiError && e.code === "possible_duplicate") setDuplicate((e.details as { existing: Patient }).existing);
      else if (e instanceof ApiError) setErrors(e.fields);
    },
  });

  useHotkeys({ Escape: onCancel });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "Enter the patient's name";
    if (!parseAgeOrDob(age)) errs.ageYears = "Enter age (42, 6m) or date of birth (12/05/1983)";
    if (!sex) errs.sex = "Choose sex";
    if (phone.replace(/\D/g, "").length < 10) errs.phone = "Enter a 10-digit mobile number";
    setErrors(errs);
    setDuplicate(undefined);
    if (Object.keys(errs).length === 0) register.mutate(false);
  };

  // Field order follows how the conversation at the desk goes: name → age → sex → phone.
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Register new patient" noValidate>
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Full name" autoFocus={!prefill.name} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} autoComplete="off" />
        <Field label="Age or date of birth" placeholder="42 · 6m · 12/05/1983" value={age} onChange={(e) => setAge(e.target.value)} error={errors.ageYears ?? errors.dob} autoFocus={!!prefill.name} autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
        <div>
          <Segmented
            label="Sex"
            name="sex"
            value={sex}
            onChange={setSex}
            options={[{ value: "F", label: "Female" }, { value: "M", label: "Male" }, { value: "O", label: "Other" }]}
          />
          {errors.sex && <p className="mt-1 text-sm text-danger">{errors.sex}</p>}
        </div>
        <Field label="Mobile number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} autoComplete="off" />
      </div>

      {duplicate && (
        <Alert
          tone="warn"
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => onDone(duplicate)} autoFocus>
                Use {duplicate.uhid}
              </Button>
              <Button onClick={() => register.mutate(true)}>Register anyway</Button>
            </div>
          }
        >
          {duplicate.name} ({duplicate.uhid}) is already registered with this number.
        </Alert>
      )}
      {register.error && !duplicate && Object.keys(errors).length === 0 && <Alert tone="danger">{register.error.message}</Alert>}

      <div className="flex gap-2">
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        <Button variant="primary" onClick={() => submit()} disabled={register.isPending} shortcut="Enter">
          {register.isPending ? "Saving…" : "Register & continue"}
        </Button>
        <Button variant="ghost" onClick={onCancel} shortcut="Esc">
          Back to search
        </Button>
      </div>
      <p className="text-sm text-ink-3">Only these 4 details are needed now. Address, ID and insurance can be added later.</p>
    </form>
  );
}
