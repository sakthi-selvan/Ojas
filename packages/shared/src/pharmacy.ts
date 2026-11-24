/**
 * Pharmacy (PMS): medicines, suppliers, purchases into batches, dispensing with GST, and the
 * Schedule H / H1 / X register.
 *
 * Quantities are whole units (tablets, capsules, bottles); prices are per pack as printed on the
 * strip, and a line's amount is mrpPerPack × units ÷ packSize, rounded to the paisa once. MRP in
 * India includes GST, so tax is worked out backwards from the amount.
 */
import { z } from "zod";
import { Paise, PaymentMode, Phone } from "./primitives";

const text = (max: number) => z.string().trim().max(max);

// ───────────────────────── Medicines ─────────────────────────

export const DosageForm = z.enum(["TAB", "CAP", "SYRUP", "SUSP", "DROPS", "INJ", "CREAM", "OINT", "GEL", "INHALER", "POWDER", "SACHET", "OTHER"]);
export type DosageForm = z.infer<typeof DosageForm>;
export const DOSAGE_FORM_LABEL: Record<DosageForm, string> = {
  TAB: "Tablet", CAP: "Capsule", SYRUP: "Syrup", SUSP: "Suspension", DROPS: "Drops", INJ: "Injection", CREAM: "Cream",
  OINT: "Ointment", GEL: "Gel", INHALER: "Inhaler", POWDER: "Powder", SACHET: "Sachet", OTHER: "Other",
};
/** Forms counted in single doses, so a prescription's "1-0-1 × 5 days" becomes 10 units. */
export const COUNTED_FORMS: readonly DosageForm[] = ["TAB", "CAP", "SACHET"];

/** Drugs and Cosmetics Rules schedules that need a prescription and, for H1 and X, a register entry. */
export const DrugSchedule = z.enum(["NONE", "H", "H1", "X"]);
export type DrugSchedule = z.infer<typeof DrugSchedule>;
export const SCHEDULE_LABEL: Record<DrugSchedule, string> = { NONE: "Over the counter", H: "Schedule H", H1: "Schedule H1", X: "Schedule X" };
export const needsPrescriber = (s: DrugSchedule) => s !== "NONE";

export const GST_RATES = [0, 5, 12, 18, 28] as const;
export const GstRate = z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)], { message: "GST is 0, 5, 12, 18 or 28%" });
export type GstRate = (typeof GST_RATES)[number];

export const ItemInput = z.object({
  name: text(120).min(2, "Enter the medicine name"),
  generic: text(200).default(""),
  form: DosageForm,
  strength: text(40).default(""),
  manufacturer: text(80).default(""),
  hsn: text(8).regex(/^$|^\d{4,8}$/, "HSN is 4 to 8 digits").default(""),
  gstRate: GstRate.default(12),
  schedule: DrugSchedule.default("NONE"),
  /** Units in one pack (10 tablets in a strip; 1 for a bottle). */
  packSize: z.number().int().min(1, "At least 1").max(1000, "At most 1000"),
  /** Warn when stock falls to this many units. 0 = no warning. */
  reorderLevel: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
});
export type ItemInput = z.input<typeof ItemInput>;

export interface Item {
  id: string;
  name: string;
  generic: string;
  form: DosageForm;
  strength: string;
  manufacturer: string;
  hsn: string;
  gstRate: GstRate;
  schedule: DrugSchedule;
  packSize: number;
  reorderLevel: number;
  active: boolean;
  /** Units in stock that haven't expired. */
  onHand: number;
  /** Nearest expiry among batches in stock (YYYY-MM-DD), if any. */
  nextExpiry: string | null;
  /** Selling price per pack of the batch that would be sold next (earliest expiry). */
  mrpPerPack: Paise | null;
}

export const itemLabel = (i: Pick<Item, "name" | "strength" | "form">) => [i.name, i.strength].filter(Boolean).join(" ");

// ───────────────────────── Suppliers ─────────────────────────

const Gstin = z.string().trim().toUpperCase().refine((v) => v === "" || /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(v), "GSTIN should be 15 characters").default("");

export const SupplierInput = z.object({
  name: text(120).min(2, "Enter the supplier name"),
  gstin: Gstin,
  drugLicence: text(60).default(""),
  phone: text(40).default(""),
  address: text(300).default(""),
});
export type SupplierInput = z.input<typeof SupplierInput>;
export interface Supplier extends z.output<typeof SupplierInput> { id: string }

// ───────────────────────── Purchases ─────────────────────────

/** Expiry as printed on the strip: month and year. Stored as the last day of that month. */
export const ExpiryMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the month, e.g. 2027-08");
export const expiryDate = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
};
/** "Aug 2027" */
export const expiryLabel = (date: string): string =>
  new Date(`${date.slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" });

export const PurchaseLineInput = z.object({
  itemId: z.uuid(),
  batchNo: text(30).min(1, "Enter the batch number").transform((s) => s.toUpperCase()),
  expiry: ExpiryMonth,
  packs: z.number().int().min(1, "At least 1 pack").max(100000),
  freePacks: z.number().int().min(0).max(100000).default(0),
  /** Supplier's rate per pack, before GST. */
  ratePerPack: Paise,
  /** Printed MRP per pack (includes GST). */
  mrpPerPack: Paise.refine((v) => v > 0, "Enter the MRP"),
  gstRate: GstRate,
});
export type PurchaseLineInput = z.input<typeof PurchaseLineInput>;

export const PurchaseInput = z.object({
  supplierId: z.uuid({ message: "Choose the supplier" }),
  invoiceNo: text(40).min(1, "Enter the supplier's invoice number"),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the invoice date"),
  lines: z.array(PurchaseLineInput).min(1, "Add at least one medicine").max(200),
  idempotencyKey: z.uuid(),
});
export type PurchaseInput = z.input<typeof PurchaseInput>;

export interface PurchaseSummary {
  id: string;
  purchaseNo: string;
  supplierName: string;
  invoiceNo: string;
  invoiceDate: string;
  receivedAt: string;
  lines: number;
  /** Cost before GST, GST, and the invoice total. */
  taxable: Paise;
  tax: Paise;
  total: Paise;
}

/** Line cost for a purchase: rate × packs (free packs cost nothing), GST on top. */
export function purchaseLineCost(l: { packs: number; ratePerPack: number; gstRate: number }): { taxable: number; tax: number } {
  const taxable = l.ratePerPack * l.packs;
  return { taxable, tax: Math.round((taxable * l.gstRate) / 100) };
}

// ───────────────────────── Stock ─────────────────────────

export interface Batch {
  id: string;
  itemId: string;
  batchNo: string;
  expiry: string;
  mrpPerPack: Paise;
  ratePerPack: Paise;
  packSize: number;
  gstRate: GstRate;
  onHand: number;
  expired: boolean;
}

export const AdjustReason = z.enum(["EXPIRED", "DAMAGED", "COUNT", "RETURNED", "OTHER"]);
export type AdjustReason = z.infer<typeof AdjustReason>;
export const ADJUST_REASON_LABEL: Record<AdjustReason, string> = {
  EXPIRED: "Expired: removed from shelf", DAMAGED: "Damaged or broken", COUNT: "Stock count correction", RETURNED: "Returned to supplier", OTHER: "Other",
};

export const AdjustInput = z.object({
  batchId: z.uuid(),
  /** Units; negative removes stock. Only a count correction may add. */
  qty: z.number().int().refine((n) => n !== 0, "Enter the quantity"),
  reason: AdjustReason,
  note: text(200).default(""),
}).refine((v) => v.qty < 0 || v.reason === "COUNT", { message: "Only a count correction can add stock", path: ["qty"] });
export type AdjustInput = z.input<typeof AdjustInput>;

/** Days before expiry when a batch shows as "expiring soon". */
export const NEAR_EXPIRY_DAYS = 90;

export interface StockAlerts {
  expired: (Batch & { itemName: string })[];
  nearExpiry: (Batch & { itemName: string })[];
  low: Item[];
}

// ───────────────────────── Sales ─────────────────────────

export const SaleLineInput = z.object({
  itemId: z.uuid(),
  /** Units to dispense. */
  qty: z.number().int().min(1, "At least 1").max(10000),
  /** Optional: sell from this batch. Otherwise the earliest-expiring batches are used. */
  batchId: z.uuid().optional(),
});
export type SaleLineInput = z.input<typeof SaleLineInput>;

export const SaleInput = z.object({
  patientId: z.uuid().optional(),
  /** Walk-in customers: a name is enough. */
  customerName: text(120).min(2, "Enter the customer's name"),
  customerPhone: z.union([z.literal(""), Phone]).default(""),
  /** Prescribing doctor; required when any medicine is Schedule H, H1 or X. */
  prescriber: text(120).default(""),
  /** The OPD visit whose prescription is being dispensed, if any. */
  appointmentId: z.uuid().optional(),
  lines: z.array(SaleLineInput).min(1, "Add at least one medicine").max(100),
  discount: Paise.default(0),
  paymentMode: PaymentMode,
  idempotencyKey: z.uuid(),
});
export type SaleInput = z.input<typeof SaleInput>;

export interface PharmacyBillLine {
  itemName: string;
  hsn: string;
  schedule: DrugSchedule;
  batchNo: string;
  expiry: string;
  qty: number;
  packSize: number;
  mrpPerPack: Paise;
  gstRate: number;
  amount: Paise;
}

export interface GstSlab { rate: number; taxable: Paise; cgst: Paise; sgst: Paise }

export interface PharmacyBill {
  id: string;
  billNo: string;
  issuedAt: string;
  customerName: string;
  customerPhone: string;
  uhid: string | null;
  prescriber: string;
  lines: PharmacyBillLine[];
  subtotal: Paise;
  discount: Paise;
  total: Paise;
  gst: GstSlab[];
  paymentMode: z.infer<typeof PaymentMode>;
  soldBy: string;
  facility: { name: string; address: string; phone: string; gstin: string; drugLicence: string };
}

/** Amount for `qty` units of a pack priced `mrpPerPack`. */
export const lineAmount = (mrpPerPack: number, qty: number, packSize: number): number => Math.round((mrpPerPack * qty) / packSize);

/**
 * GST inside MRP-priced lines after a bill discount. The discount is shared across lines in
 * proportion to their amounts (the last line takes the rounding), then each line's tax is
 * amount × rate ÷ (100 + rate), split equally into CGST and SGST (sales within the state).
 */
export function gstBreakup(lines: { amount: number; gstRate: number }[], discount: number): GstSlab[] {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const slabs = new Map<number, { gross: number; tax: number }>();
  let given = 0;
  lines.forEach((l, i) => {
    const share = i === lines.length - 1 ? discount - given : subtotal ? Math.round((discount * l.amount) / subtotal) : 0;
    given += share;
    const net = l.amount - share;
    const tax = Math.round((net * l.gstRate) / (100 + l.gstRate));
    const s = slabs.get(l.gstRate) ?? { gross: 0, tax: 0 };
    s.gross += net;
    s.tax += tax;
    slabs.set(l.gstRate, s);
  });
  return [...slabs.entries()].sort((a, b) => a[0] - b[0]).map(([rate, s]) => {
    const cgst = Math.floor(s.tax / 2);
    return { rate, taxable: s.gross - s.tax, cgst, sgst: s.tax - cgst };
  });
}

export interface SaleSummary {
  id: string;
  billNo: string;
  issuedAt: string;
  customerName: string;
  total: Paise;
  paymentMode: z.infer<typeof PaymentMode>;
  items: number;
}

/** Schedule H1 / X register (and H, for the clinic's own record). One row per medicine sold. */
export interface RegisterEntry {
  issuedAt: string;
  billNo: string;
  customerName: string;
  customerPhone: string;
  prescriber: string;
  itemName: string;
  schedule: DrugSchedule;
  batchNo: string;
  qty: number;
}

// ───────────────────────── Prescriptions waiting at the counter ─────────────────────────

/** A medicine line from a signed prescription, matched to stock where possible. */
export interface DispenseLine {
  drug: string;
  dose: string;
  frequency: string;
  durationDays: number | null;
  /** The pharmacy item whose name best matches, if any. */
  item: Item | null;
  /** Units suggested from frequency × days (counted forms), else 1 pack. */
  suggestedQty: number;
}

export interface PendingPrescription {
  appointmentId: string;
  signedAt: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  uhid: string;
  prescriber: string;
  lines: DispenseLine[];
}

/** Doses per day from "1-0-1", "1-1-1-1", "0-0-1"; null for SOS, weekly and free text. */
export function dosesPerDay(frequency: string): number | null {
  const f = frequency.trim();
  if (!/^\d+(\.\d+)?(-\d+(\.\d+)?){1,3}$/.test(f)) return null;
  return f.split("-").reduce((s, x) => s + Number(x), 0);
}
