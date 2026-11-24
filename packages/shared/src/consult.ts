/**
 * OPD consultation (the doctor's screen): vitals, notes, diagnoses, prescriptions and lab orders.
 *
 * One encounter per appointment. While it is a draft the doctor's screen saves it as they type.
 * Signing locks it and keeps a snapshot; a correction re-opens it with a reason and the next
 * signing adds a new version, so nothing a doctor signed is ever lost.
 */
import { z } from "zod";
import type { Patient, AppointmentStatus } from "./index";

const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const text = (max: number) => z.string().trim().max(max);

// ───────────────────────── Vitals ─────────────────────────

/** Every field is optional: a nurse records what was measured. Temperature is in °F, as on Indian OPD cards. */
export const VitalsInput = z.object({
  heightCm: opt(z.number().min(30, "Height looks wrong").max(250, "Height looks wrong")),
  weightKg: opt(z.number().min(0.5, "Weight looks wrong").max(400, "Weight looks wrong")),
  temperatureF: opt(z.number().min(90, "Temperature looks wrong").max(110, "Temperature looks wrong")),
  pulse: opt(z.number().int().min(20, "Pulse looks wrong").max(250, "Pulse looks wrong")),
  bpSystolic: opt(z.number().int().min(50, "BP looks wrong").max(300, "BP looks wrong")),
  bpDiastolic: opt(z.number().int().min(20, "BP looks wrong").max(200, "BP looks wrong")),
  respRate: opt(z.number().int().min(4, "Breathing rate looks wrong").max(80, "Breathing rate looks wrong")),
  spo2: opt(z.number().int().min(50, "SpO₂ looks wrong").max(100, "SpO₂ looks wrong")),
  /** Random blood sugar, mg/dL (glucometer at the desk). */
  bloodSugar: opt(z.number().int().min(20, "Sugar looks wrong").max(800, "Sugar looks wrong")),
}).refine((v) => v.bpSystolic == null || v.bpDiastolic == null || v.bpSystolic > v.bpDiastolic, {
  message: "Systolic must be higher than diastolic",
  path: ["bpDiastolic"],
});
export type VitalsInput = z.input<typeof VitalsInput>;
export type Vitals = { [K in keyof z.output<typeof VitalsInput>]-?: number | null };

export const VITAL_KEYS = ["heightCm", "weightKg", "temperatureF", "pulse", "bpSystolic", "bpDiastolic", "respRate", "spo2", "bloodSugar"] as const;

export const emptyVitals = (): Vitals => Object.fromEntries(VITAL_KEYS.map((k) => [k, null])) as Vitals;

/** BMI to one decimal, when both height and weight are known. */
export const bmiOf = (v: Pick<Vitals, "heightCm" | "weightKg">): number | null =>
  v.heightCm && v.weightKg ? Math.round((v.weightKg / (v.heightCm / 100) ** 2) * 10) / 10 : null;

// ───────────────────────── Clinical content ─────────────────────────

export const DiagnosisInput = z.object({
  text: text(200).min(2, "Enter the diagnosis"),
  /** Optional ICD-10 code, e.g. "J06.9". */
  code: text(10).regex(/^$|^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/i, "ICD-10 codes look like J06.9").transform((s) => s.toUpperCase()).default(""),
});
export type DiagnosisInput = z.input<typeof DiagnosisInput>;
export type Diagnosis = z.output<typeof DiagnosisInput>;

export const MedTiming = z.enum(["AFTER_FOOD", "BEFORE_FOOD", "WITH_FOOD", "EMPTY_STOMACH", "BEDTIME", "ANY"]);
export type MedTiming = z.infer<typeof MedTiming>;
export const MED_TIMING_LABEL: Record<MedTiming, string> = {
  AFTER_FOOD: "After food",
  BEFORE_FOOD: "Before food",
  WITH_FOOD: "With food",
  EMPTY_STOMACH: "Empty stomach",
  BEDTIME: "At bedtime",
  ANY: "",
};

/** The usual frequency shorthands (morning-noon-night). Free text is allowed too. */
export const FREQUENCIES = ["1-0-1", "1-1-1", "1-0-0", "0-0-1", "0-1-0", "1-1-1-1", "SOS", "Once", "Weekly"] as const;

export const MedicationInput = z.object({
  drug: text(120).min(2, "Enter the medicine"),
  /** Strength or amount per dose: "500 mg", "1 tab", "5 ml". */
  dose: text(40).default(""),
  frequency: text(20).default(""),
  timing: MedTiming.default("AFTER_FOOD"),
  /** Days; empty means "continue" (long-term medicines). */
  durationDays: opt(z.number().int().min(1, "At least 1 day").max(365, "At most 365 days")),
  instructions: text(200).default(""),
});
export type MedicationInput = z.input<typeof MedicationInput>;
export type Medication = Omit<z.output<typeof MedicationInput>, "durationDays"> & { durationDays: number | null };

export const LabOrderInput = z.object({
  test: text(120).min(2, "Enter the test"),
  notes: text(200).default(""),
});
export type LabOrderInput = z.input<typeof LabOrderInput>;
export type LabOrder = z.output<typeof LabOrderInput>;

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date");

/** The doctor's part of the encounter (vitals are saved separately, so a nurse and a doctor never overwrite each other). */
export const ConsultNotesInput = z.object({
  chiefComplaint: text(1000).default(""),
  history: text(4000).default(""),
  examination: text(4000).default(""),
  advice: text(4000).default(""),
  followUpDate: opt(IsoDate),
  diagnoses: z.array(DiagnosisInput).max(20).default([]),
  medications: z.array(MedicationInput).max(40).default([]),
  labOrders: z.array(LabOrderInput).max(40).default([]),
  /** The notesVersion the screen started from; a stale save is refused rather than overwriting. */
  notesVersion: z.number().int().min(0),
});
export type ConsultNotesInput = z.input<typeof ConsultNotesInput>;

export const ReopenInput = z.object({ reason: text(300).min(5, "Say briefly what needs correcting") });
export type ReopenInput = z.input<typeof ReopenInput>;

export const EncounterStatus = z.enum(["DRAFT", "SIGNED"]);
export type EncounterStatus = z.infer<typeof EncounterStatus>;

export interface Encounter {
  id: string;
  status: EncounterStatus;
  /** How many times it has been signed (0 while the first draft is open). */
  version: number;
  notesVersion: number;
  vitals: Vitals;
  vitalsRecordedAt: string | null;
  vitalsRecordedBy: string | null;
  chiefComplaint: string;
  history: string;
  examination: string;
  advice: string;
  followUpDate: string | null;
  diagnoses: Diagnosis[];
  medications: Medication[];
  labOrders: LabOrder[];
  signedAt: string | null;
  signedBy: string | null;
  /** Set while a signed record is open for correction. */
  reopenReason: string | null;
}

export interface ConsultPractitioner {
  id: string;
  name: string;
  department: string;
  qualification: string;
  registrationNo: string;
}

/** Everything the doctor's screen and the printed prescription need for one appointment. */
export interface ConsultView {
  appointmentId: string;
  token: number;
  slotStart: string;
  appointmentStatus: AppointmentStatus;
  patient: Patient;
  practitioner: ConsultPractitioner;
  encounter: Encounter | null;
  facility: { name: string; address: string; phone: string; email: string };
}

/** One signed visit in the patient's history. */
export interface PastVisit {
  appointmentId: string;
  date: string;
  practitionerName: string;
  chiefComplaint: string;
  vitals: Vitals;
  diagnoses: Diagnosis[];
  medications: Medication[];
  labOrders: LabOrder[];
  advice: string;
  followUpDate: string | null;
}

export const SuggestionKind = z.enum(["drug", "diagnosis", "lab"]);
export type SuggestionKind = z.infer<typeof SuggestionKind>;

/** Autocomplete entry: things this clinic has written before, most used first. Drugs carry the last way they were prescribed. */
export interface Suggestion {
  text: string;
  uses: number;
  code?: string;
  med?: Omit<Medication, "drug">;
}

/** Common tests offered before the clinic has a history of its own (the laboratory module will bring the real catalogue). */
export const COMMON_LAB_TESTS = [
  "Complete blood count (CBC)", "Fasting blood sugar (FBS)", "Post-prandial blood sugar (PPBS)", "HbA1c", "Lipid profile",
  "Liver function test (LFT)", "Kidney function test (RFT)", "Thyroid profile (T3, T4, TSH)", "Urine routine", "Serum creatinine",
  "ESR", "CRP", "Dengue NS1 / IgM", "Malaria antigen", "Widal", "Chest X-ray", "ECG", "USG abdomen",
] as const;
