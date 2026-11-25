/**
 * Laboratory (LIMS): the test catalogue with reference ranges, orders (the lab bill), sample
 * collection with accession numbers, result entry with flags, verification and the report.
 *
 * A test's parameters are copied onto each order when it's billed, so later catalogue edits
 * never change a report that's already been issued.
 */
import { z } from "zod";
import { Paise, PaymentMode, type Sex } from "./primitives";
import type { CounterMode } from "./pharmacy";

const text = (max: number) => z.string().trim().max(max);
const num = z.number().finite();

// ───────────────────────── Catalogue ─────────────────────────

export const LabSection = z.enum(["HAEM", "BIOCHEM", "HORMONE", "SERO", "CLINPATH", "MICRO", "OTHER"]);
export type LabSection = z.infer<typeof LabSection>;
export const LAB_SECTION_LABEL: Record<LabSection, string> = {
  HAEM: "Haematology", BIOCHEM: "Biochemistry", HORMONE: "Hormones", SERO: "Serology", CLINPATH: "Clinical pathology", MICRO: "Microbiology", OTHER: "Other",
};

export const SampleType = z.enum(["EDTA", "SERUM", "FLUORIDE", "CITRATE", "URINE", "STOOL", "SWAB", "SPUTUM", "OTHER"]);
export type SampleType = z.infer<typeof SampleType>;
export const SAMPLE_LABEL: Record<SampleType, string> = {
  EDTA: "Blood, EDTA (purple cap)", SERUM: "Blood, serum (red/yellow cap)", FLUORIDE: "Blood, fluoride (grey cap)", CITRATE: "Blood, citrate (blue cap)",
  URINE: "Urine", STOOL: "Stool", SWAB: "Swab", SPUTUM: "Sputum", OTHER: "Other",
};
/** Short form for tube labels. */
export const SAMPLE_SHORT: Record<SampleType, string> = {
  EDTA: "EDTA", SERUM: "SERUM", FLUORIDE: "FLUORIDE", CITRATE: "CITRATE", URINE: "URINE", STOOL: "STOOL", SWAB: "SWAB", SPUTUM: "SPUTUM", OTHER: "OTHER",
};

export const RangeSex = z.enum(["ANY", "M", "F"]);
export type RangeSex = z.infer<typeof RangeSex>;

/**
 * One reference range; the most specific one that fits the patient (sex, then age) is used. Ages are
 * in years, fractional for babies (7 days is 7/365.25). A range may carry its own critical limits
 * (a newborn's haemoglobin of 21 is normal, an adult's is not).
 */
export const RefRange = z
  .object({
    sex: RangeSex.default("ANY"),
    ageFrom: num.min(0).max(130).nullable().default(null),
    ageTo: num.min(0).max(130).nullable().default(null),
    low: num.nullable().default(null),
    high: num.nullable().default(null),
    criticalLow: num.nullable().default(null),
    criticalHigh: num.nullable().default(null),
  })
  .refine((r) => r.low !== null || r.high !== null, { message: "Enter a low or high limit", path: ["low"] })
  .refine((r) => r.low === null || r.high === null || r.low <= r.high, { message: "Low is above high", path: ["high"] })
  .refine((r) => r.ageFrom === null || r.ageTo === null || r.ageFrom < r.ageTo, { message: "Age range is back to front", path: ["ageTo"] });
export type RefRange = z.output<typeof RefRange>;

export const ParamKind = z.enum(["NUMERIC", "TEXT", "CHOICE"]);
export type ParamKind = z.infer<typeof ParamKind>;

export const ParameterInput = z.object({
  /** Stable within the test, so results survive renaming a parameter. */
  id: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, "Use letters, numbers, - or _"),
  name: text(80).min(1, "Name the parameter"),
  unit: text(30).default(""),
  kind: ParamKind.default("NUMERIC"),
  decimals: z.number().int().min(0).max(4).default(1),
  ranges: z.array(RefRange).max(24).default([]),
  /** Values beyond these are critical (flagged LL / HH, to be phoned to the doctor). */
  criticalLow: num.nullable().default(null),
  criticalHigh: num.nullable().default(null),
  /** CHOICE: the values offered. */
  choices: z.array(text(60).min(1)).max(20).default([]),
  /** TEXT / CHOICE: the normal answer (e.g. "Negative"); anything else is flagged abnormal. */
  normal: text(80).default(""),
  /** Printed instead of the worked-out range, for interpretive ranges (e.g. HbA1c). */
  refText: text(300).default(""),
  /** Printed as a sub-heading above this parameter (e.g. "Differential count"). */
  group: text(60).default(""),
});
export type ParameterInput = z.input<typeof ParameterInput>;
export type Parameter = z.output<typeof ParameterInput>;

export const TestInput = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,16}$/, "2–16 letters, numbers or -"),
    name: text(120).min(2, "Enter the test name"),
    section: LabSection,
    sampleType: SampleType,
    price: Paise,
    tatHours: z.number().int().min(1).max(720).default(24),
    method: text(80).default(""),
    /** Other names doctors write for it, so consultation orders find it ("RBS", "Sugar random"). */
    aliases: z.array(text(80).min(1)).max(12).default([]),
    /** Printed under the test on the report. */
    notes: text(1000).default(""),
    active: z.boolean().default(true),
    parameters: z.array(ParameterInput).min(1, "Add at least one parameter").max(60),
  })
  .refine((t) => new Set(t.parameters.map((p) => p.id)).size === t.parameters.length, { message: "Two parameters share an id", path: ["parameters"] });
export type TestInput = z.input<typeof TestInput>;

export interface LabTest extends Omit<z.output<typeof TestInput>, "parameters"> {
  id: string;
  parameters: Parameter[];
}

// ───────────────────────── Ranges and flags ─────────────────────────

/** Age in years (fractional, for children's ranges) on a date. */
export function ageYears(dob: string | null, on: Date): number | null {
  if (!dob) return null;
  const ms = on.getTime() - new Date(`${dob}T00:00:00`).getTime();
  return ms < 0 ? 0 : ms / (365.25 * 24 * 3600 * 1000);
}

/**
 * The range that fits this patient best. An age-specific range beats an open one (a child's
 * haemoglobin range wins over the adult male one), and a sex-specific range beats ANY.
 */
export function pickRange(ranges: RefRange[], sex: Sex, age: number | null): RefRange | null {
  const fits = ranges.filter((r) => {
    if (r.sex !== "ANY" && r.sex !== sex) return false;
    if (r.ageFrom === null && r.ageTo === null) return true;
    if (age === null) return false;
    return (r.ageFrom === null || age >= r.ageFrom) && (r.ageTo === null || age < r.ageTo);
  });
  const score = (r: RefRange) => (r.ageFrom !== null || r.ageTo !== null ? 2 : 0) + (r.sex !== "ANY" ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Under this age, a range with no age limits is an adult range and is marked so on the report. */
export const ADULT_AGE = 18;

const DAY = 1 / 365.25;
const MONTH = 1 / 12;
export type AgeUnit = "d" | "mo" | "y";
export const AGE_UNIT_LABEL: Record<AgeUnit, string> = { d: "days", mo: "months", y: "years" };
export const yearsOf = (n: number, unit: AgeUnit) => (unit === "d" ? n * DAY : unit === "mo" ? n * MONTH : n);
/** The unit that shows these ages (in years) as whole numbers: days for the first month, then months under two years. */
export function ageUnitFor(...years: (number | null)[]): AgeUnit {
  const set = years.filter((y): y is number => y !== null && y > 0);
  const whole = (n: number) => Math.abs(n - Math.round(n)) < 0.01;
  if (set.every((y) => whole(y))) return "y";
  if (set.every((y) => whole(y / MONTH))) return "mo";
  return "d";
}
/** Days are shown whole (a month boundary is 30.44 days, read as 30); months and years to two decimals. */
export const inUnit = (years: number, unit: AgeUnit) =>
  unit === "d" ? Math.round(years / DAY) : Math.round((unit === "mo" ? years / MONTH : years) * 100) / 100;

/** "0–7 days", "1–6 months", "12 years and over"; empty for a range with no age limits. */
export function ageBandText(r: Pick<RefRange, "ageFrom" | "ageTo">): string {
  if (r.ageFrom === null && r.ageTo === null) return "";
  const unit = ageUnitFor(r.ageFrom, r.ageTo);
  const u = AGE_UNIT_LABEL[unit];
  if (r.ageTo === null) return `${inUnit(r.ageFrom!, unit)} ${u} and over`;
  return `${inUnit(r.ageFrom ?? 0, unit)}–${inUnit(r.ageTo, unit)} ${u}`;
}

const fmt = (n: number, d: number) => n.toFixed(d);

export function rangeText(p: Parameter, r: RefRange | null): string {
  if (p.refText) return p.refText;
  if (p.kind !== "NUMERIC") return p.normal;
  if (!r) return "";
  if (r.low !== null && r.high !== null) return `${fmt(r.low, p.decimals)} – ${fmt(r.high, p.decimals)}`;
  if (r.high !== null) return `Up to ${fmt(r.high, p.decimals)}`;
  return `Above ${fmt(r.low!, p.decimals)}`;
}

/** L / H: outside the reference range. LL / HH: beyond a critical limit. A: a text answer other than the normal one. */
export const ResultFlag = z.enum(["L", "H", "LL", "HH", "A"]);
export type ResultFlag = z.infer<typeof ResultFlag>;
export const FLAG_LABEL: Record<ResultFlag, string> = { L: "Low", H: "High", LL: "Critically low", HH: "Critically high", A: "Abnormal" };
export const isCritical = (f: ResultFlag | null) => f === "LL" || f === "HH";

/** A numeric value as typed: "12.5", "<0.5" or ">1000" (limits of the analyser). */
export const NUMERIC_VALUE = /^([<>]\s*)?-?\d+(\.\d+)?$/;

export interface LabResult {
  paramId: string;
  value: string;
  flag: ResultFlag | null;
  /** The reference range as printed for this patient. */
  refText: string;
}

/** Works out a value's flag and printed range for this patient. Returns null for a numeric parameter given text. */
export function interpret(p: Parameter, value: string, sex: Sex, age: number | null): LabResult | null {
  const v = value.trim();
  const range = pickRange(p.ranges, sex, age);
  // A child read against an adult range is marked, so nobody mistakes it for a children's range.
  const adultForChild = p.kind === "NUMERIC" && !p.refText && range !== null && range.ageFrom === null && range.ageTo === null && age !== null && age < ADULT_AGE;
  const refText = rangeText(p, range) + (adultForChild ? " (adult range)" : "");
  if (p.kind !== "NUMERIC") {
    const abnormal = p.normal !== "" && v.toLowerCase() !== p.normal.toLowerCase();
    return { paramId: p.id, value: v, flag: abnormal ? "A" : null, refText };
  }
  if (!NUMERIC_VALUE.test(v)) return null;
  const n = Number(v.replace(/^[<>]\s*/, ""));
  let flag: ResultFlag | null = null;
  const critLow = range?.criticalLow ?? p.criticalLow;
  const critHigh = range?.criticalHigh ?? p.criticalHigh;
  if (critLow !== null && n < critLow) flag = "LL";
  else if (critHigh !== null && n > critHigh) flag = "HH";
  else if (range?.low != null && n < range.low) flag = "L";
  else if (range?.high != null && n > range.high) flag = "H";
  return { paramId: p.id, value: v, flag, refText };
}

// ───────────────────────── Orders ─────────────────────────

export const LabBillInput = z.object({
  patientId: z.uuid({ message: "Choose the patient" }),
  /** Set when billed from a doctor's consultation. */
  appointmentId: z.uuid().optional(),
  referredBy: text(120).default(""),
  testIds: z.array(z.uuid()).min(1, "Add at least one test").max(40),
  discount: Paise.default(0),
  paymentMode: PaymentMode,
  /** Charge to this in-patient's bill instead of taking payment now (paymentMode is then ignored). */
  admissionId: z.uuid().optional(),
  idempotencyKey: z.uuid(),
});
export type LabBillInput = z.input<typeof LabBillInput>;

export const TestStatus = z.enum(["ORDERED", "COLLECTED", "RESULTED", "VERIFIED"]);
export type TestStatus = z.infer<typeof TestStatus>;
export const TEST_STATUS_LABEL: Record<TestStatus, string> = {
  ORDERED: "Sample due", COLLECTED: "Sample taken", RESULTED: "To verify", VERIFIED: "Ready",
};

export const CollectInput = z.object({
  /** The tests whose samples were taken; all still waiting when left out. */
  orderTestIds: z.array(z.uuid()).max(40).optional(),
});
export type CollectInput = z.input<typeof CollectInput>;

export const RejectSampleInput = z.object({ reason: text(200).min(3, "Say why (e.g. haemolysed, clotted, too little)") });
export type RejectSampleInput = z.input<typeof RejectSampleInput>;

export const ResultsInput = z.object({
  values: z.record(z.string(), text(200)),
  remarks: text(1000).default(""),
  /** The row version the screen loaded; a stale save is refused. */
  rowVersion: z.number().int().min(1),
});
export type ResultsInput = z.input<typeof ResultsInput>;

export const VerifyInput = z.object({ rowVersion: z.number().int().min(1) });
export const AmendInput = z.object({ reason: text(300).min(5, "Say briefly what needs correcting") });
export type AmendInput = z.input<typeof AmendInput>;

export interface LabPatient {
  id: string;
  uhid: string;
  name: string;
  sex: Sex;
  dob: string | null;
  phone: string;
}

export interface LabSample {
  id: string;
  accessionNo: string;
  sampleType: SampleType;
  collectedAt: string;
  collectedBy: string;
  rejectedAt: string | null;
  rejectReason: string;
}

export interface OrderTest {
  id: string;
  testId: string;
  code: string;
  name: string;
  section: LabSection;
  sampleType: SampleType;
  method: string;
  notes: string;
  price: Paise;
  status: TestStatus;
  parameters: Parameter[];
  results: LabResult[];
  remarks: string;
  accessionNo: string | null;
  enteredAt: string | null;
  enteredBy: string | null;
  verifiedAt: string | null;
  /** Display name of the person who verified, printed as the signatory. */
  verifiedBy: string | null;
  amendReason: string | null;
  rowVersion: number;
  dueAt: string;
}

export interface LabOrderSummary {
  id: string;
  orderNo: string;
  orderedAt: string;
  patient: LabPatient;
  referredBy: string;
  total: Paise;
  tests: Pick<OrderTest, "id" | "code" | "name" | "status" | "sampleType" | "accessionNo" | "dueAt">[];
  critical: boolean;
}

export interface LabOrderDetail extends Omit<LabOrderSummary, "tests"> {
  appointmentId: string | null;
  subtotal: Paise;
  discount: Paise;
  /** "IPD": charged to the in-patient bill, settled at discharge. */
  paymentMode: CounterMode;
  admissionId: string | null;
  admissionNo: string | null;
  billedBy: string;
  tests: OrderTest[];
  samples: LabSample[];
  facility: { name: string; address: string; phone: string; gstin: string };
}

/** A signed consultation's tests waiting to be billed at the lab, with the catalogue test each one most likely means. */
export interface LabRequest {
  appointmentId: string;
  signedAt: string;
  patient: LabPatient;
  prescriber: string;
  lines: { test: string; notes: string; match: LabTest | null }[];
}

/** A verified result for the doctor's screen. */
export interface PatientLabResult {
  orderId: string;
  orderNo: string;
  orderedAt: string;
  verifiedAt: string;
  name: string;
  parameters: Parameter[];
  results: LabResult[];
  remarks: string;
}

export const labTestOf = (o: Pick<OrderTest, "status">[]) => ({
  due: o.filter((t) => t.status === "ORDERED").length,
  waiting: o.filter((t) => t.status === "COLLECTED").length,
  toVerify: o.filter((t) => t.status === "RESULTED").length,
  ready: o.filter((t) => t.status === "VERIFIED").length,
});
