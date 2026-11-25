/**
 * Clinic configuration: facility details, doctors and their weekly schedules, holidays and leave.
 * Changing any of this never alters past appointments or bills, which keep the values they were made with.
 */
import { z } from "zod";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ───────────────────────── Facility ─────────────────────────

export const FacilityInput = z.object({
  name: z.string().trim().min(2, "Enter the clinic or hospital name").max(120),
  address: z.string().trim().max(300).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.literal(""), z.email("Enter a valid email")]).default(""),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(v), "GSTIN should be 15 characters, like 33ABCDE1234F1Z5")
    .default(""),
  receiptFooter: z.string().trim().max(120).default(""),
  /** Retail drug licence number(s), printed on pharmacy bills (e.g. "TN-01-20B-1234, TN-01-21B-1234"). */
  drugLicence: z.string().trim().max(120).default(""),
  /** Prefix for patient IDs, e.g. "OJ-" → OJ-000123. Can only change before the first patient is registered. */
  uhidPrefix: z.string().trim().toUpperCase().regex(/^[A-Z]{1,5}-?$/, "1–5 letters, optionally ending with a dash"),
  /** GST on in-patient room rent (non-ICU) above `roomGstAbove` per day; 0 turns it off. */
  roomGstPercent: z.number({ error: "Enter a percentage" }).min(0, "0 or more").max(28, "At most 28%").default(5),
  /** Paise per day; a room charging more than this pays GST on its whole rent. */
  roomGstAbove: z.number({ error: "Enter an amount" }).int().min(0, "0 or more").default(500_000),
});
export type FacilityInput = z.input<typeof FacilityInput>;

export interface Facility {
  name: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  receiptFooter: string;
  drugLicence: string;
  uhidPrefix: string;
  roomGstPercent: number;
  roomGstAbove: number;
  /** False until the administrator finishes the first-run wizard. */
  setupCompleted: boolean;
  /** UHID prefix is locked once patients exist. */
  hasPatients: boolean;
}

/** What anyone (even before sign-in) may see: shown on the sign-in screen. */
export interface PublicFacility {
  name: string;
  address: string;
  phone: string;
  setupCompleted: boolean;
}

// ───────────────────────── Doctors & schedules ─────────────────────────

export const Session = z.object({
  /** 0 = Sunday … 6 = Saturday */
  weekday: z.number().int().min(0).max(6),
  start: Time,
  end: Time,
});
export type Session = z.infer<typeof Session>;

export const SLOT_CHOICES = [5, 10, 15, 20, 30, 45, 60] as const;

export const PractitionerInput = z
  .object({
    name: z.string().trim().min(2, "Enter the doctor's name").max(120),
    department: z.string().trim().min(2, "Enter a department or speciality").max(80),
    qualification: z.string().trim().max(120).default(""),
    registrationNo: z.string().trim().max(40).default(""),
    phone: z.string().trim().max(40).default(""),
    /** Paise */
    consultationFee: z.number().int().min(0, "Fee can't be negative").max(10_000_000),
    slotMinutes: z.number().int().min(5).max(120),
    sessions: z.array(Session).max(21),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    for (const [i, s] of v.sessions.entries()) {
      if (toMin(s.end) <= toMin(s.start)) {
        ctx.addIssue({ code: "custom", path: ["sessions", i, "end"], message: "End time must be after start time" });
      } else if (toMin(s.end) - toMin(s.start) < v.slotMinutes) {
        ctx.addIssue({ code: "custom", path: ["sessions", i, "end"], message: `Session is shorter than one ${v.slotMinutes}-minute slot` });
      }
    }
    for (let d = 0; d < 7; d++) {
      const day = v.sessions.map((s, i) => ({ ...s, i })).filter((s) => s.weekday === d).sort((a, b) => toMin(a.start) - toMin(b.start));
      if (day.length > 3) ctx.addIssue({ code: "custom", path: ["sessions"], message: "At most 3 sessions a day" });
      for (let k = 1; k < day.length; k++) {
        if (toMin(day[k]!.start) < toMin(day[k - 1]!.end)) {
          ctx.addIssue({ code: "custom", path: ["sessions", day[k]!.i, "start"], message: `${WEEKDAYS[d]} sessions overlap` });
        }
      }
    }
  });
export type PractitionerInput = z.input<typeof PractitionerInput>;

// ───────────────────────── Holidays & leave ─────────────────────────

export const HolidayInput = z.object({ date: IsoDate, name: z.string().trim().min(2, "Name the holiday").max(80) });
export type HolidayInput = z.input<typeof HolidayInput>;
export interface Holiday { date: string; name: string }

export const LeaveInput = z
  .object({ practitionerId: z.uuid(), fromDate: IsoDate, toDate: IsoDate, reason: z.string().trim().max(120).default("") })
  .refine((v) => v.fromDate <= v.toDate, { message: "End date can't be before start date", path: ["toDate"] });
export type LeaveInput = z.input<typeof LeaveInput>;
export interface Leave { id: string; practitionerId: string; practitionerName: string; fromDate: string; toDate: string; reason: string }
