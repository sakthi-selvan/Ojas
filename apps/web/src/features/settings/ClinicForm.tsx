import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FacilityInput, type Facility } from "@ojas/shared";
import { api } from "../../lib/api";
import { Alert, Button, Field } from "../../components/ui";
import { formErrors } from "./forms";

/** Text fields as typed; the room GST percentage and threshold (in rupees) are converted on save. */
type Form = Pick<Facility, "name" | "address" | "phone" | "email" | "gstin" | "receiptFooter" | "drugLicence" | "uhidPrefix"> & { roomGstPercent: string; roomGstAbove: string };
const blank: Form = { name: "", address: "", phone: "", email: "", gstin: "", receiptFooter: "Get well soon", drugLicence: "", uhidPrefix: "OJ-", roomGstPercent: "5", roomGstAbove: "5000" };
const toInput = (f: Form) => ({
  ...f,
  roomGstPercent: f.roomGstPercent.trim() === "" ? Number.NaN : Number(f.roomGstPercent),
  roomGstAbove: f.roomGstAbove.trim() === "" ? Number.NaN : Math.round(Number(f.roomGstAbove.replace(/[,\s]/g, "")) * 100),
});

/** Clinic details: printed on every receipt. Used by the first-run wizard and by Settings. */
export function ClinicForm({ submitLabel = "Save", onSaved }: { submitLabel?: string; onSaved?: (f: Facility) => void }) {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ["settings-facility"], queryFn: api.settingsFacility });
  const [form, setForm] = useState<Form>(blank);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!current.data) return;
    const { setupCompleted: _s, hasPatients: _h, roomGstPercent, roomGstAbove, ...rest } = current.data;
    setForm({
      ...rest, receiptFooter: rest.receiptFooter || (current.data.setupCompleted ? "" : blank.receiptFooter),
      roomGstPercent: String(roomGstPercent), roomGstAbove: String(roomGstAbove / 100),
    });
  }, [current.data]);

  const save = useMutation({
    mutationFn: api.saveFacility,
    onSuccess: (f) => {
      qc.setQueryData(["settings-facility"], f);
      void qc.invalidateQueries({ queryKey: ["facility"] });
      setSaved(true);
      onSaved?.(f);
    },
    onError: (e) => setErrs(formErrors(e)),
  });

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSaved(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = toInput(form);
    const parsed = FacilityInput.safeParse(input);
    if (!parsed.success) return setErrs(formErrors(parsed.error));
    setErrs({});
    save.mutate(input);
  };

  const locked = current.data?.hasPatients;
  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Field label="Clinic or hospital name" className="sm:col-span-2" autoFocus value={form.name} onChange={set("name")} error={errs.name} placeholder="e.g. Sunrise Family Clinic" />
      <Field label="Address" className="sm:col-span-2" value={form.address} onChange={set("address")} error={errs.address} hint="Printed on receipts" />
      <Field label="Phone" inputMode="tel" value={form.phone} onChange={set("phone")} error={errs.phone} />
      <Field label="Email (optional)" type="email" value={form.email} onChange={set("email")} error={errs.email} />
      <Field label="GSTIN (optional)" value={form.gstin} onChange={set("gstin")} error={errs.gstin} hint="Printed on receipts when filled in" maxLength={15} />
      <Field
        label="Patient ID prefix"
        value={form.uhidPrefix}
        onChange={set("uhidPrefix")}
        error={errs.uhidPrefix}
        disabled={locked}
        maxLength={6}
        hint={locked ? "Locked: patients already have IDs with this prefix" : `First patient will be ${(form.uhidPrefix || "OJ-").toUpperCase()}000001`}
      />
      <Field label="Drug licence no." className="sm:col-span-2" value={form.drugLicence} onChange={set("drugLicence")} error={errs.drugLicence} hint="For the pharmacy: printed on every medicine bill" />
      <Field label="GST on room rent %" inputMode="decimal" value={form.roomGstPercent} onChange={set("roomGstPercent")} error={errs.roomGstPercent}
        hint="In-patient rooms (not ICU) above the daily limit. 0 turns it off." />
      <Field label="Room rent GST applies above ₹ per day" inputMode="numeric" value={form.roomGstAbove} onChange={set("roomGstAbove")} error={errs.roomGstAbove}
        hint="Taxed on the whole rent once over this. Applies to stays that start after saving." />
      <Field label="Receipt footer" className="sm:col-span-2" value={form.receiptFooter} onChange={set("receiptFooter")} error={errs.receiptFooter} hint="A short line at the bottom of every receipt" />
      {save.error && !Object.keys(errs).length && <div className="sm:col-span-2"><Alert tone="danger">{save.error.message}</Alert></div>}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={save.isPending || current.isLoading}>{save.isPending ? "Saving…" : submitLabel}</Button>
        {saved && !onSaved && <span role="status" className="text-sm font-medium text-ok">Saved</span>}
      </div>
    </form>
  );
}
