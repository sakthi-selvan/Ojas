import { Banknote, CreditCard, Smartphone } from "lucide-react";
import { ageLabel, type PaymentMode, type Sex } from "@ojas/shared";
import { Segmented } from "../../components/ui";

/** "1,500.50" → 150050 paise; anything unreadable is 0. */
export const paiseOf = (rupees: string): number => Math.round((Number(rupees.replace(/[^\d.]/g, "")) || 0) * 100);

export const SEX_LABEL: Record<Sex, string> = { M: "Male", F: "Female", O: "Other" };
export const ageSex = (p: { dob: string | null; sex: Sex }) => `${p.dob ? ageLabel(p.dob) : "Age not known"} · ${SEX_LABEL[p.sex]}`;

export function PaymentModeField({ value, onChange, name }: { value: PaymentMode; onChange: (m: PaymentMode) => void; name: string }) {
  return (
    <Segmented
      label="Payment"
      name={name}
      value={value}
      onChange={onChange}
      options={[
        { value: "CASH", label: "Cash", icon: <Banknote aria-hidden className="size-4" /> },
        { value: "UPI", label: "UPI", icon: <Smartphone aria-hidden className="size-4" /> },
        { value: "CARD", label: "Card", icon: <CreditCard aria-hidden className="size-4" /> },
      ]}
    />
  );
}
