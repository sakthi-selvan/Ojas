import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Printer } from "lucide-react";
import { WARD_KIND_LABEL, formatINR, type Admission, type Patient, type PaymentMode } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Button, Card, Field, Select } from "../../components/ui";
import { PatientStep } from "../front-desk/PatientStep";
import { PaymentModeField, ageSex, paiseOf } from "./common";
import { useIpdPrint } from "./printables";

/** Admitting: the patient, the admitting doctor, a free bed, why, who is with them, and the advance. F9 admits. */
export function AdmitPanel({ initialBedId, onOpen }: { initialBedId: string | null; onOpen: (admissionId: string) => void }) {
  const qc = useQueryClient();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [bedId, setBedId] = useState(initialBedId ?? "");
  const [reason, setReason] = useState("");
  const [attendant, setAttendant] = useState({ name: "", relation: "", phone: "" });
  const [depositText, setDepositText] = useState("");
  const [mode, setMode] = useState<PaymentMode>("CASH");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Admission | null>(null);
  const idemKey = useRef(crypto.randomUUID());
  const wards = useQuery({ queryKey: ["ipd-wards"], queryFn: () => api.wards() });
  const doctors = useQuery({ queryKey: ["practitioners"], queryFn: api.practitioners });
  const freeWards = (wards.data ?? []).map((w) => ({ ...w, beds: w.beds.filter((b) => b.state === "FREE") })).filter((w) => w.beds.length);
  const ward = freeWards.find((w) => w.beds.some((b) => b.id === bedId));
  const fix = (k: string) => setErrs(({ [k]: _, ...rest }) => rest);

  const admit = useMutation({
    mutationFn: () => api.admit({
      patientId: patient!.id, practitionerId: doctorId, bedId, reason,
      attendantName: attendant.name, attendantRelation: attendant.relation, attendantPhone: attendant.phone,
      deposit: paiseOf(depositText), paymentMode: mode, idempotencyKey: idemKey.current,
    }),
    onSuccess: (a) => {
      setDone(a);
      void qc.invalidateQueries({ queryKey: ["ipd-wards"] });
      void qc.invalidateQueries({ queryKey: ["ipd-admissions"] });
    },
    onError: (e) => {
      setErrs(e instanceof ApiError ? e.fields : {});
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });
  const submit = () => !done && patient && !admit.isPending && admit.mutate();
  useHotkeys({ F9: submit });

  if (done) return <Admitted admission={done} onOpen={() => onOpen(done.id)} />;
  const fieldErrors = Object.keys(errs).length > 0;

  return (
    <Card className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold">Admit a patient</h2>
      {!patient ? (
        <PatientStep onSelect={setPatient} />
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{patient.name} <span className="font-normal text-ink-3">· {patient.uhid}</span></div>
              <div className="text-sm text-ink-2">{ageSex(patient)} · {patient.phone}</div>
            </div>
            <Button variant="ghost" onClick={() => setPatient(null)}>Change</Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Admitting doctor" value={doctorId} onChange={(e) => { setDoctorId(e.target.value); fix("practitionerId"); }} error={errs.practitionerId}>
              <option value="">Choose…</option>
              {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.name}{d.department ? ` · ${d.department}` : ""}</option>)}
            </Select>
            <Select label="Bed" value={bedId} onChange={(e) => { setBedId(e.target.value); fix("bedId"); }} error={errs.bedId}
              hint={ward ? `${WARD_KIND_LABEL[ward.kind]}: ${formatINR(ward.bedCharge)} a day${ward.nursingCharge ? ` + nursing ${formatINR(ward.nursingCharge)}` : ""}` : freeWards.length ? undefined : "No free beds"}>
              <option value="">Choose…</option>
              {freeWards.map((w) => (
                <optgroup key={w.id} label={`${w.name} (${formatINR(w.bedCharge)}/day)`}>
                  {w.beds.map((b) => <option key={b.id} value={b.id}>{w.name} · {b.label}</option>)}
                </optgroup>
              ))}
            </Select>
          </div>
          <Field label="Reason for admission" value={reason} placeholder="Provisional diagnosis or complaint" autoFocus
            onChange={(e) => { setReason(e.target.value); fix("reason"); }} error={errs.reason} />
          <fieldset className="grid gap-3 sm:grid-cols-[1fr_10rem_12rem]">
            <legend className="mb-1 text-sm font-medium text-ink-2">Attendant (who stays with the patient)</legend>
            <Field label="Name" value={attendant.name} onChange={(e) => setAttendant((a) => ({ ...a, name: e.target.value }))} error={errs.attendantName} />
            <Field label="Relation" value={attendant.relation} placeholder="Wife, son…" onChange={(e) => setAttendant((a) => ({ ...a, relation: e.target.value }))} />
            <Field label="Mobile" inputMode="tel" value={attendant.phone} onChange={(e) => { setAttendant((a) => ({ ...a, phone: e.target.value })); fix("attendantPhone"); }} error={errs.attendantPhone} />
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Advance ₹" inputMode="decimal" value={depositText} placeholder="0" onChange={(e) => { setDepositText(e.target.value); fix("deposit"); }} error={errs.deposit} />
            {paiseOf(depositText) > 0 && <PaymentModeField name="admit-mode" value={mode} onChange={setMode} />}
          </div>
          {admit.error && !fieldErrors && <Alert tone="danger">{admit.error.message}</Alert>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm text-ink-3">{paiseOf(depositText) > 0 ? `Advance ${formatINR(paiseOf(depositText))} will be receipted.` : "No advance taken."}</span>
            <Button variant="primary" size="lg" shortcut="F9" disabled={admit.isPending} onClick={submit}>Admit</Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function Admitted({ admission: a, onOpen }: { admission: Admission; onOpen: () => void }) {
  const { print, view } = useIpdPrint();
  const deposit = a.payments.find((p) => p.kind === "DEPOSIT");
  useHotkeys({ Enter: onOpen, ...(deposit ? { P: () => print({ kind: "receipt", admission: a, payment: deposit }) } : {}) });
  return (
    <Card className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div role="status" className="flex items-center gap-4 rounded-xl bg-ok-soft p-4 text-ok">
        <CheckCircle2 aria-hidden className="size-8 shrink-0" />
        <div className="flex-1">
          <div className="font-semibold">Admitted · {a.admissionNo}{a.emergency ? " · emergency" : ""}{a.mlc ? " · MLC" : ""}</div>
          <div className="text-sm">{a.patient.name} · {a.bed?.wardName}, bed {a.bed?.label} · {a.doctor.name}{deposit ? ` · advance ${formatINR(deposit.amount)} (${deposit.receiptNo})` : ""}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="lg" onClick={onOpen} shortcut="Enter" autoFocus>Open chart</Button>
        {deposit && <Button size="lg" onClick={() => print({ kind: "receipt", admission: a, payment: deposit })} shortcut="P"><Printer aria-hidden className="size-4" /> Print advance receipt</Button>}
      </div>
      {view}
    </Card>
  );
}
