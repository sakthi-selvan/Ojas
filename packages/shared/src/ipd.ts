/**
 * In-patients (IPD): wards and beds, admission, the bedside chart (vitals, notes, medicines),
 * charges and deposits, the discharge summary, and the final bill.
 *
 * Bed charges follow the midnight census: each night the patient is in a bed at midnight is one
 * day, charged at the rate of the ward they were in at that midnight. A stay that crosses no
 * midnight is charged as one day.
 */
import { z } from "zod";
import { Paise, PaymentMode, Phone, Sex } from "./primitives";
import { DiagnosisInput, IsoDate, MedicationInput, VitalsInput, type Diagnosis, type Medication, type Vitals } from "./consult";

const text = (max: number) => z.string().trim().max(max);
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

// ───────────────────────── Wards, beds and services ─────────────────────────

export const WardKind = z.enum(["GENERAL", "SEMI_PRIVATE", "PRIVATE", "ICU", "OTHER"]);
export type WardKind = z.infer<typeof WardKind>;
export const WARD_KIND_LABEL: Record<WardKind, string> = {
  GENERAL: "General ward",
  SEMI_PRIVATE: "Semi-private",
  PRIVATE: "Private room",
  ICU: "ICU",
  OTHER: "Other",
};

export const BedLabel = text(12).min(1, "Name the bed").regex(/^[A-Za-z0-9][A-Za-z0-9 /-]*$/, "Letters, numbers, space, / or -");

export const WardInput = z.object({
  name: text(60).min(2, "Name the ward"),
  kind: WardKind,
  /** Per day, in paise. */
  bedCharge: Paise,
  nursingCharge: Paise.default(0),
  beds: z.array(BedLabel).min(1, "Add at least one bed").max(200, "At most 200 beds per ward")
    .refine((b) => new Set(b.map((x) => x.toUpperCase())).size === b.length, "Each bed needs its own name"),
  active: z.boolean().default(true),
});
export type WardInput = z.input<typeof WardInput>;

/** "G1-G10" or "101, 102, 103" → bed names. Ranges keep the prefix and any zero padding. */
export function expandBeds(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z /-]*?)(\d+)\s*[-–]\s*\1?(\d+)$/);
    if (m && Number(m[3]) >= Number(m[2]) && Number(m[3]) - Number(m[2]) < 200) {
      const width = m[2]!.startsWith("0") ? m[2]!.length : 0;
      for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(`${m[1]}${String(n).padStart(width, "0")}`);
    } else out.push(part);
  }
  return out;
}

export const BedState = z.enum(["FREE", "OCCUPIED", "CLEANING"]);
export type BedState = z.infer<typeof BedState>;
export const BED_STATE_LABEL: Record<BedState, string> = { FREE: "Free", OCCUPIED: "Occupied", CLEANING: "Being cleaned" };

export interface BedOccupant {
  admissionId: string;
  admissionNo: string;
  patientName: string;
  uhid: string;
  sex: Sex;
  dob: string | null;
  admittedAt: string;
  doctorName: string;
  /** The doctor has signed the discharge summary; waiting for the bill to be settled. */
  dischargeAdvised: boolean;
}

export interface Bed {
  id: string;
  label: string;
  active: boolean;
  state: BedState;
  occupant: BedOccupant | null;
}

export interface Ward {
  id: string;
  name: string;
  kind: WardKind;
  bedCharge: Paise;
  nursingCharge: Paise;
  active: boolean;
  beds: Bed[];
}

export const ChargeCategory = z.enum(["DOCTOR", "NURSING", "PROCEDURE", "INVESTIGATION", "MEDICINE", "CONSUMABLE", "OTHER"]);
export type ChargeCategory = z.infer<typeof ChargeCategory>;
export const CHARGE_CATEGORY_LABEL: Record<ChargeCategory | "BED", string> = {
  BED: "Room",
  DOCTOR: "Doctor visits",
  NURSING: "Nursing",
  PROCEDURE: "Procedures",
  INVESTIGATION: "Investigations",
  MEDICINE: "Medicines",
  CONSUMABLE: "Consumables",
  OTHER: "Other",
};

/** A priced service the desk can add to a bill in one click (doctor visit, dressing, oxygen per hour…). */
export const ServiceInput = z.object({
  name: text(80).min(2, "Name the service"),
  category: ChargeCategory,
  price: Paise,
  active: z.boolean().default(true),
});
export type ServiceInput = z.input<typeof ServiceInput>;
export interface IpdService extends z.output<typeof ServiceInput> { id: string }

// ───────────────────────── Admission ─────────────────────────

const OptionalPhone = z.union([z.literal(""), Phone]).default("");

export const AdmitInput = z.object({
  patientId: z.uuid(),
  practitionerId: z.uuid({ message: "Choose the admitting doctor" }),
  bedId: z.uuid({ message: "Choose a bed" }),
  reason: text(300).min(2, "Why is the patient being admitted?"),
  attendantName: text(80).default(""),
  attendantRelation: text(40).default(""),
  attendantPhone: OptionalPhone,
  /** Advance paid at admission, in paise. */
  deposit: Paise.default(0),
  paymentMode: PaymentMode.default("CASH"),
  idempotencyKey: z.uuid(),
});
export type AdmitInput = z.input<typeof AdmitInput>;

export const TransferInput = z.object({
  bedId: z.uuid({ message: "Choose the new bed" }),
  reason: text(200).min(3, "Why the move?"),
});
export type TransferInput = z.input<typeof TransferInput>;

// ───────────────────────── Chart ─────────────────────────

export const NoteKind = z.enum(["DOCTOR", "NURSING"]);
export type NoteKind = z.infer<typeof NoteKind>;
export const NOTE_KIND_LABEL: Record<NoteKind, string> = { DOCTOR: "Doctor's note", NURSING: "Nursing note" };

export const NoteInput = z.object({ kind: NoteKind, text: text(4000).min(2, "Write the note") });
export type NoteInput = z.input<typeof NoteInput>;

export { VitalsInput as IpdVitalsInput };

export const Route = z.enum(["ORAL", "IV", "IM", "SC", "INHALED", "TOPICAL", "RECTAL", "OTHER"]);
export type Route = z.infer<typeof Route>;
export const ROUTE_LABEL: Record<Route, string> = {
  ORAL: "Oral", IV: "IV", IM: "IM", SC: "SC", INHALED: "Inhaled", TOPICAL: "Topical", RECTAL: "Rectal", OTHER: "Other",
};

/** A medicine on the in-patient treatment chart. */
export const MedOrderInput = MedicationInput.extend({ route: Route.default("ORAL") });
export type MedOrderInput = z.input<typeof MedOrderInput>;

export const StopMedInput = z.object({ reason: text(200).default("") });
export type StopMedInput = z.input<typeof StopMedInput>;

export const DoseStatus = z.enum(["GIVEN", "HELD", "REFUSED"]);
export type DoseStatus = z.infer<typeof DoseStatus>;
export const DOSE_STATUS_LABEL: Record<DoseStatus, string> = { GIVEN: "Given", HELD: "Held", REFUSED: "Refused" };

export const DoseInput = z.object({ status: DoseStatus.default("GIVEN"), note: text(200).default("") })
  .refine((d) => d.status === "GIVEN" || d.note.length >= 3, { message: "Say why it wasn't given", path: ["note"] });
export type DoseInput = z.input<typeof DoseInput>;

// ───────────────────────── Money ─────────────────────────

export const ChargeInput = z.object({
  serviceId: z.uuid().optional(),
  description: text(120).min(2, "What is the charge for?"),
  category: ChargeCategory,
  quantity: z.number().int().min(1, "At least 1").max(1000, "At most 1000"),
  unitPrice: Paise.refine((p) => p > 0, "Enter the price"),
});
export type ChargeInput = z.input<typeof ChargeInput>;

export const CancelChargeInput = z.object({ reason: text(200).min(3, "Say why it is being removed") });
export type CancelChargeInput = z.input<typeof CancelChargeInput>;

export const DepositInput = z.object({
  amount: Paise.refine((p) => p > 0, "Enter the amount"),
  paymentMode: PaymentMode,
  idempotencyKey: z.uuid(),
});
export type DepositInput = z.input<typeof DepositInput>;

// ───────────────────────── Discharge ─────────────────────────

export const DischargeType = z.enum(["NORMAL", "LAMA", "REFERRED", "DEATH"]);
export type DischargeType = z.infer<typeof DischargeType>;
export const DISCHARGE_TYPE_LABEL: Record<DischargeType, string> = {
  NORMAL: "Discharged",
  LAMA: "Left against medical advice (LAMA)",
  REFERRED: "Referred to another hospital",
  DEATH: "Death",
};

export const SummaryInput = z.object({
  dischargeType: DischargeType.default("NORMAL"),
  diagnoses: z.array(DiagnosisInput).max(20).default([]),
  presentingComplaints: text(4000).default(""),
  courseInHospital: text(8000).default(""),
  investigations: text(8000).default(""),
  treatmentGiven: text(4000).default(""),
  conditionAtDischarge: text(1000).default(""),
  medications: z.array(MedicationInput).max(40).default([]),
  advice: text(4000).default(""),
  followUpDate: opt(IsoDate),
  /** The version the screen started from; a stale save is refused rather than overwriting. */
  summaryVersion: z.number().int().min(0),
});
export type SummaryInput = z.input<typeof SummaryInput>;
export type DischargeSummary = Omit<z.output<typeof SummaryInput>, "summaryVersion" | "followUpDate" | "medications" | "diagnoses"> & {
  diagnoses: Diagnosis[];
  medications: Medication[];
  followUpDate: string | null;
};

export const SettleInput = z.object({
  discount: Paise.default(0),
  paymentMode: PaymentMode,
  /** The bill total the desk was looking at; if a charge was added meanwhile the settlement is refused. */
  expectedSubtotal: Paise,
  idempotencyKey: z.uuid(),
});
export type SettleInput = z.input<typeof SettleInput>;

// ───────────────────────── Views ─────────────────────────

export type AdmissionStatus = "ADMITTED" | "DISCHARGED";

export interface IpdPatient { id: string; uhid: string; name: string; sex: Sex; dob: string | null; phone: string }

export interface BedStay {
  wardName: string;
  wardKind: WardKind;
  bedLabel: string;
  bedCharge: Paise;
  nursingCharge: Paise;
  from: string;
  to: string | null;
  reason: string;
}

export interface ChartNote { id: string; kind: NoteKind; text: string; at: string; by: string }
export interface VitalsEntry { id: string; vitals: Vitals; at: string; by: string }

export interface DoseEntry { id: string; status: DoseStatus; note: string; at: string; by: string }
export interface MedOrder {
  id: string;
  med: Medication & { route: Route };
  startedAt: string;
  startedBy: string;
  stoppedAt: string | null;
  stoppedBy: string | null;
  stopReason: string;
  doses: DoseEntry[];
}

export interface Charge {
  id: string;
  description: string;
  category: ChargeCategory;
  quantity: number;
  unitPrice: Paise;
  amount: Paise;
  at: string;
  by: string;
  cancelledAt: string | null;
  cancelReason: string;
}

export type IpdPaymentKind = "DEPOSIT" | "FINAL" | "REFUND";
export interface IpdPayment { id: string; receiptNo: string; kind: IpdPaymentKind; amount: Paise; mode: PaymentMode; at: string; by: string }

export interface BillLine { category: ChargeCategory | "BED"; description: string; quantity: number; unitPrice: Paise; amount: Paise }

export interface IpdBill {
  /** Bed-days so far (midnight census, at least one). */
  days: number;
  lines: BillLine[];
  subtotal: Paise;
  discount: Paise;
  total: Paise;
  /** Deposits and final payments, less refunds. */
  paid: Paise;
  /** What the patient still owes; negative means the hospital owes a refund. */
  balance: number;
}

export interface Admission {
  id: string;
  admissionNo: string;
  status: AdmissionStatus;
  admittedAt: string;
  admittedBy: string;
  dischargedAt: string | null;
  patient: IpdPatient;
  doctor: { id: string; name: string; department: string; qualification: string; registrationNo: string };
  reason: string;
  attendant: { name: string; relation: string; phone: string };
  bed: { id: string; label: string; wardId: string; wardName: string; wardKind: WardKind } | null;
  stays: BedStay[];
  notes: ChartNote[];
  vitals: VitalsEntry[];
  meds: MedOrder[];
  charges: Charge[];
  payments: IpdPayment[];
  summary: DischargeSummary | null;
  summaryVersion: number;
  summarySignedAt: string | null;
  summarySignedBy: string | null;
  finalBillNo: string | null;
  bill: IpdBill;
  facility: { name: string; address: string; phone: string; email: string; gstin: string };
}

export interface AdmissionSummary {
  id: string;
  admissionNo: string;
  status: AdmissionStatus;
  admittedAt: string;
  dischargedAt: string | null;
  patient: IpdPatient;
  doctorName: string;
  wardName: string;
  bedLabel: string;
  dischargeType: DischargeType | null;
  dischargeAdvised: boolean;
}

/** Days charged under the midnight census: local midnights in (from, to], at least one. */
export function midnightsBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const m = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  while (m.getTime() <= to.getTime()) {
    out.push(new Date(m));
    m.setDate(m.getDate() + 1);
  }
  return out;
}
