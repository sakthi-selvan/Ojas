/**
 * The server is the single source of truth for time; client PC clocks drift and would corrupt the
 * audit trail and queue order. Everything date-like is computed here in the facility's local zone
 * (the server PC's Windows time zone).
 */
const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of `d` in local time. */
export const localDate = (d: Date = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local Date for a calendar day and a "HH:MM[:SS]" wall-clock time. */
export function atLocal(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export const isIsoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
