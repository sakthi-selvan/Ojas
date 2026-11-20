import { ZodError } from "zod";
import { ApiError } from "../../lib/api";

/** Field errors from client-side validation (Zod) or from the server, keyed like "name" or "sessions.3.end". */
export function formErrors(e: unknown): Record<string, string> {
  if (e instanceof ApiError) return e.fields;
  if (e instanceof ZodError) {
    const out: Record<string, string> = {};
    for (const i of e.issues) out[i.path.join(".") || "_"] ??= i.message;
    return out;
  }
  return {};
}

/** Fees are typed in rupees and stored in paise. */
export const toPaise = (rupees: string): number => Math.round(Number(rupees || "0") * 100);
export const toRupees = (paise: number): string => (paise % 100 ? (paise / 100).toFixed(2) : String(paise / 100));
