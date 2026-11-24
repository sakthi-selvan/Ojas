/** Building blocks shared by every contract (kept apart so modules can import them without a cycle). */
import { z } from "zod";

// ───────────────────────── Primitives ─────────────────────────

/** Money is always stored and transferred as integer paise (1 INR = 100 paise). Never floats. */
export const Paise = z.number().int().nonnegative();
export type Paise = z.infer<typeof Paise>;

export const Sex = z.enum(["M", "F", "O"]);
export type Sex = z.infer<typeof Sex>;

export const PaymentMode = z.enum(["CASH", "UPI", "CARD"]);
export type PaymentMode = z.infer<typeof PaymentMode>;

/** Indian mobile numbers: 10 digits starting 6–9. Accepts +91 / 0 prefixes and spaces, normalises to 10 digits. */
export const Phone = z
  .string()
  .transform((s) => s.replace(/[^\d]/g, "").replace(/^(91|0)(?=\d{10}$)/, ""))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"));
