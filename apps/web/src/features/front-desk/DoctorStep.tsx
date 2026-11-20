import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatINR, type Practitioner } from "@hs/shared";
import { api, timeLabel, today } from "../../lib/api";
import { Alert, Button, Kbd, cx } from "../../components/ui";

const LAST_DOCTOR = "hs.frontdesk.lastDoctor";
export const rememberDoctor = (id: string) => {
  try {
    localStorage.setItem(LAST_DOCTOR, id);
  } catch { /* storage unavailable: just don't remember */ }
};
const lastDoctor = () => {
  try {
    return localStorage.getItem(LAST_DOCTOR) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Step 2: doctor and slot. The last-used doctor and their next free slot are preselected, so for
 * the common case the receptionist only presses Enter. Arrow keys move within each group.
 */
export function DoctorStep({
  doctorId, slotStart, notice, onChange, onContinue,
}: {
  doctorId?: string;
  slotStart?: string;
  notice?: string;
  onChange: (doctorId: string, slotStart?: string) => void;
  onContinue: () => void;
}) {
  const doctors = useQuery({ queryKey: ["practitioners"], queryFn: api.practitioners, staleTime: 60_000 });
  const date = today();
  const slots = useQuery({
    queryKey: ["slots", doctorId, date],
    queryFn: () => api.slots(doctorId!, date),
    enabled: !!doctorId,
    refetchInterval: 60_000,
  });

  // Preselect a doctor: the one already chosen, else the last used here, else the first.
  useEffect(() => {
    if (doctorId || !doctors.data?.length) return;
    const last = lastDoctor();
    onChange(doctors.data.find((d) => d.id === last)?.id ?? doctors.data[0]!.id);
  }, [doctors.data, doctorId, onChange]);

  // Keep a valid slot selected: if none (or it was just taken), jump to the next free one.
  const free = useMemo(() => (slots.data ?? []).filter((s) => s.available), [slots.data]);
  useEffect(() => {
    if (!doctorId || !slots.data) return;
    if (!slotStart || !free.some((s) => s.start === slotStart)) {
      const next = free[0]?.start;
      if (next !== slotStart) onChange(doctorId, next);
    }
  }, [slots.data, free, doctorId, slotStart, onChange]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.target as HTMLInputElement).type === "radio" && slotStart) {
      e.preventDefault();
      onContinue();
    }
  };

  const selected = doctors.data?.find((d) => d.id === doctorId);

  // Put keyboard focus on the chosen doctor once, so Enter continues and arrow keys switch doctor.
  const box = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !doctorId || !doctors.data) return;
    box.current?.querySelector<HTMLInputElement>('input[name="doctor"]:checked')?.focus();
    focused.current = true;
  }, [doctorId, doctors.data]);

  return (
    <div ref={box} className="flex flex-col gap-4" onKeyDown={onKeyDown}>
      {notice && <Alert tone="warn">{notice}</Alert>}
      {doctors.error && <Alert tone="danger">{(doctors.error as Error).message}</Alert>}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink-2">Doctor</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {doctors.data?.map((d: Practitioner) => {
            const checked = d.id === doctorId;
            return (
              <label
                key={d.id}
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus",
                  checked ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="doctor"
                  className="sr-only"
                  checked={checked}
                  onChange={() => onChange(d.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{d.name}</div>
                  <div className="truncate text-sm text-ink-2">{d.department}</div>
                </div>
                <div className="text-sm font-semibold tabular-nums">{formatINR(d.consultationFee)}</div>
              </label>
            );
          })}
        </div>
      </fieldset>

      {selected && (
        <fieldset>
          <legend className="mb-2 flex w-full items-center text-sm font-medium text-ink-2">
            Time today
            <span className="ml-auto font-normal text-ink-3">{free.length} free · {selected.slotMinutes} min slots</span>
          </legend>
          {slots.isLoading && <p className="text-sm text-ink-3">Loading slots…</p>}
          {slots.data && free.length === 0 && <Alert tone="warn">{selected.name} has no free slots left today. Choose another doctor.</Alert>}
          <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto p-0.5">
            {free.slice(0, 48).map((s) => {
              const checked = s.start === slotStart;
              return (
                <label
                  key={s.start}
                  className={cx(
                    "cursor-pointer rounded-md border px-2.5 py-1.5 text-sm font-medium tabular-nums has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus",
                    checked ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-surface-2",
                  )}
                >
                  <input type="radio" name="slot" className="sr-only" checked={checked} onChange={() => onChange(selected.id, s.start)} />
                  {timeLabel(s.start)}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div>
        <Button variant="primary" onClick={onContinue} disabled={!slotStart}>
          Continue to bill <Kbd>Enter</Kbd>
        </Button>
      </div>
    </div>
  );
}
