/**
 * Money corrections and the day-end report: cancelling a paid OPD bill with a refund, and what
 * each counter took (and gave back) on a day, by payment mode and by person, for the cash handover.
 */
import { z } from "zod";
import { PaymentMode, type Paise } from "./primitives";

const text = (max: number) => z.string().trim().max(max);

export const CancelBillInput = z.object({
  reason: text(200).min(5, "Say why the bill is cancelled"),
  /** How the money goes back; usually the way it was paid. */
  refundMode: PaymentMode,
});
export type CancelBillInput = z.input<typeof CancelBillInput>;

export interface BillCancellation { at: string; by: string; reason: string; refundMode: PaymentMode; refunded: Paise }

export type CashSource = "OPD" | "PHARMACY" | "LAB" | "IPD";
export const CASH_SOURCE_LABEL: Record<CashSource, string> = { OPD: "OPD consultations", PHARMACY: "Pharmacy", LAB: "Laboratory", IPD: "In-patients" };

export interface DayReportRow { source: CashSource; mode: PaymentMode; received: Paise; refunded: Paise; count: number }
export interface DayReport {
  date: string;
  /** Money in and out at the counters, per source and payment mode. */
  rows: DayReportRow[];
  /** Per person and mode, for the cash handover at shift end. */
  byUser: { user: string; name: string; mode: PaymentMode; received: Paise; refunded: Paise }[];
  /** Counter bills put on in-patient bills: no money taken today, it's collected at discharge. */
  onIpBills: { source: "PHARMACY" | "LAB"; amount: Paise; count: number }[];
  discounts: { source: CashSource; amount: Paise; count: number }[];
  cancellations: { billNo: string; patient: string; amount: Paise; reason: string; by: string; at: string }[];
}
