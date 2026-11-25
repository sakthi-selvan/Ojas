/**
 * The dose schedule: when each charted medicine falls due on the ward, and which of those times
 * have a dose recorded against them. Pure and clock-free so the server, the screens and the tests
 * all agree. Times are local ward times.
 */
import type { DoseEntry, Inpatient, MedOrder } from "./ipd";

/** Ward round times for the usual frequencies (hour of day, local). */
const WARD_HOURS: Record<string, number[]> = {
  OD: [8], QD: [8], DAILY: [8], "ONCE DAILY": [8], HS: [21], NIGHT: [21],
  BD: [8, 20], BID: [8, 20], Q12H: [8, 20],
  TDS: [8, 14, 20], TID: [8, 14, 20], Q8H: [6, 14, 22],
  QID: [8, 13, 18, 22], Q6H: [0, 6, 12, 18], Q4H: [2, 6, 10, 14, 18, 22],
};
/** Where each part of an "x-x-x" pattern falls: morning, afternoon, night (and a fourth, bedtime). */
const PATTERN_HOURS: Record<number, number[]> = { 3: [8, 14, 20], 4: [8, 13, 18, 22] };

export type DoseTiming = { kind: "times"; hours: number[] } | { kind: "once" } | { kind: "as-needed" };

/** What a frequency means on the ward. Anything not recognised is "as needed": no fixed times, nothing goes overdue. */
export function doseTiming(frequency: string): DoseTiming {
  const f = frequency.trim().toUpperCase().replace(/\s+/g, " ");
  if (/^(STAT|ONCE|SINGLE DOSE|NOW)$/.test(f)) return { kind: "once" };
  const pattern = f.replace(/\s/g, "");
  if (/^\d+(\/\d+)?(-\d+(\/\d+)?){2,3}$/.test(pattern)) {
    const parts = pattern.split("-");
    const hours = PATTERN_HOURS[parts.length]!.filter((_, i) => parts[i] !== "0");
    return hours.length ? { kind: "times", hours } : { kind: "as-needed" };
  }
  const hours = WARD_HOURS[f] ?? WARD_HOURS[f.replace(/\s/g, "")];
  return hours ? { kind: "times", hours } : { kind: "as-needed" };
}

/**
 * DONE: a dose (given, held or refused) is recorded for this time.
 * DUE: within an hour either side of now. LATE: more than an hour past with nothing recorded.
 * LATER: still to come.
 */
export type SlotState = "DONE" | "DUE" | "LATE" | "LATER";
export interface DoseSlot { at: string; state: SlotState; dose: DoseEntry | null }

const HOUR = 3_600_000;
/** A dose recorded up to this long before its time counts for that time (given a little early). */
const EARLY = HOUR;
/** Nothing recorded this long after its time: overdue. */
const GRACE = HOUR;
/** Scheduled times earlier than this after the order don't count: the first dose follows the order. */
const FIRST_DOSE_LEAD = 15 * 60_000;

/**
 * The scheduled times of one medicine from `from` until the end of `now`'s day, each matched with
 * the dose recorded for it. A dose counts for the latest scheduled time at or before it (allowing an
 * hour early); a second dose for the same time is an extra and doesn't fill an earlier gap.
 */
export function doseSlots(m: MedOrder, now: Date, from = new Date(now.getTime() - 24 * HOUR)): DoseSlot[] {
  const timing = doseTiming(m.med.frequency);
  if (timing.kind === "as-needed") return [];
  const start = new Date(m.startedAt).getTime();
  const courseEnd = m.med.durationDays ? start + m.med.durationDays * 24 * HOUR : Infinity;
  const stop = Math.min(m.stoppedAt ? new Date(m.stoppedAt).getTime() : Infinity, courseEnd);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();

  let times: number[];
  if (timing.kind === "once") times = [start];
  else {
    times = [];
    // Start from the order's day so dose matching sees every time since the order, then trim to the window.
    const day = new Date(Math.min(start, from.getTime()));
    for (let d = new Date(day.getFullYear(), day.getMonth(), day.getDate()); d.getTime() < endOfToday; d.setDate(d.getDate() + 1)) {
      for (const h of timing.hours) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
        if (t >= start - FIRST_DOSE_LEAD && t < stop && t < endOfToday) times.push(t);
      }
    }
  }

  const matched = new Map<number, DoseEntry>();
  const ascending = [...m.doses].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const d of ascending) {
    const at = new Date(d.at).getTime();
    let slot: number | undefined;
    for (const t of times) if (t <= at + EARLY) slot = t;
    if (slot !== undefined && !matched.has(slot)) matched.set(slot, d);
  }

  const n = now.getTime();
  return times
    .filter((t) => t >= from.getTime() || (timing.kind === "once" && !matched.has(t)))
    .map((t): DoseSlot => {
      const dose = matched.get(t) ?? null;
      const state: SlotState = dose ? "DONE" : n > t + GRACE ? "LATE" : n >= t - EARLY ? "DUE" : "LATER";
      return { at: new Date(t).toISOString(), state, dose };
    });
}

export const SLOT_STATE_LABEL: Record<SlotState, string> = { DONE: "Recorded", DUE: "Due now", LATE: "Overdue", LATER: "Later" };

/** One admitted patient's active medicines, for the ward's dose round. */
export interface WardMeds extends Inpatient { meds: MedOrder[] }

/** How many doses are due now and overdue (in the last day) across a patient's medicines. */
export function doseCounts(meds: MedOrder[], now: Date): { due: number; late: number } {
  let due = 0, late = 0;
  for (const m of meds) {
    if (m.stoppedAt) continue;
    for (const s of doseSlots(m, now)) {
      if (s.state === "DUE") due++;
      else if (s.state === "LATE") late++;
    }
  }
  return { due, late };
}
