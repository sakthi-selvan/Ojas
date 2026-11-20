/**
 * Shared contracts between the Ojas server and every client (web UI, Electron, future mobile).
 * One source of truth: the server validates requests with these schemas and the UI uses the same
 * schemas for forms, so the two can never drift apart.
 */
import { z } from "zod";

export * from "./auth";

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

// ───────────────────────── Patients ─────────────────────────

/** Quick registration needs only these four fields. Everything else is optional and can be added later. */
export const QuickRegisterInput = z
  .object({
    name: z.string().trim().min(2, "Name is too short").max(120),
    sex: Sex,
    phone: Phone,
    /** Either age in years OR date of birth (YYYY-MM-DD). Receptionists usually know the age. */
    ageYears: z.number().int().min(0).max(130).optional(),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.ageYears !== undefined || v.dob !== undefined, {
    message: "Enter age or date of birth",
    path: ["ageYears"],
  });
export type QuickRegisterInput = z.input<typeof QuickRegisterInput>;

export interface Patient {
  id: string;
  uhid: string;
  name: string;
  sex: Sex;
  phone: string;
  dob: string | null;
  /** True when DOB was derived from an age, so the UI can show "~42 y". */
  dobEstimated: boolean;
  createdAt: string;
}

export interface PatientSearchResult extends Patient {
  lastVisitAt: string | null;
}

// ───────────────────────── Practitioners & slots ─────────────────────────

export interface Practitioner {
  id: string;
  name: string;
  department: string;
  consultationFee: Paise;
  slotMinutes: number;
  /** "09:00" */
  dayStart: string;
  /** "13:00" */
  dayEnd: string;
}

export interface Slot {
  /** ISO timestamp */
  start: string;
  available: boolean;
}

// ───────────────────────── Front desk checkout ─────────────────────────

/**
 * The single transaction behind the front-desk screen: book a slot, raise the bill and record the
 * payment, all or nothing. A patient never ends up booked but unbilled, or billed but unbooked.
 */
export const CheckoutInput = z.object({
  patientId: z.uuid(),
  practitionerId: z.uuid(),
  slotStart: z.iso.datetime({ offset: true }),
  discount: Paise.default(0),
  paymentMode: PaymentMode,
  /** Client-generated key: retries after a network blip never double-book or double-charge. */
  idempotencyKey: z.uuid(),
});
export type CheckoutInput = z.input<typeof CheckoutInput>;

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: Paise;
  amount: Paise;
}

export interface Receipt {
  appointmentId: string;
  token: number;
  slotStart: string;
  invoiceNo: string;
  invoiceId: string;
  issuedAt: string;
  patient: Pick<Patient, "uhid" | "name" | "sex" | "phone" | "dob" | "dobEstimated">;
  practitioner: Pick<Practitioner, "name" | "department">;
  lines: InvoiceLine[];
  subtotal: Paise;
  discount: Paise;
  total: Paise;
  paymentMode: PaymentMode;
  facility: { name: string; address: string; phone: string };
}

// ───────────────────────── Queue ─────────────────────────

export const AppointmentStatus = z.enum(["BOOKED", "CHECKED_IN", "IN_CONSULT", "DONE", "CANCELLED"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export interface QueueItem {
  appointmentId: string;
  token: number;
  slotStart: string;
  status: AppointmentStatus;
  patientName: string;
  uhid: string;
  practitionerId: string;
  practitionerName: string;
}

/** Messages pushed over the realtime socket. */
export type ServerEvent = { type: "queue.changed"; date: string } | { type: "hello"; serverTime: string };

// ───────────────────────── Helpers ─────────────────────────

export const formatINR = (paise: Paise): string =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(paise / 100);

/** Age label from DOB, e.g. "42 y", "7 m", "12 d". */
export function ageLabel(dob: string | null, now: Date = new Date()): string {
  if (!dob) return "—";
  const d = new Date(dob + "T00:00:00");
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years--;
  if (years >= 1) return `${years} y`;
  const months = (now.getFullYear() - d.getFullYear()) * 12 + m - (now.getDate() < d.getDate() ? 1 : 0);
  if (months >= 1) return `${months} m`;
  return `${Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000))} d`;
}
