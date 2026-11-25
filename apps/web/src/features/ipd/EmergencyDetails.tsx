import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Admission, Sex } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { Alert, Button, Field, Segmented } from "../../components/ui";
import { useAdmissionUpdate } from "./AdmissionView";

/** Completes the registration of a patient admitted through casualty in a hurry. */
export function CompleteRegistration({ admission: a, onDone }: { admission: Admission; onDone: () => void }) {
  const updated = useAdmissionUpdate();
  const unknown = a.patient.name.startsWith("Unknown ");
  const [name, setName] = useState(unknown ? "" : a.patient.name);
  const [sex, setSex] = useState<Sex>(a.patient.sex);
  const [age, setAge] = useState("");
  const [dob, setDob] = useState(a.patient.dob ?? "");
  const [phone, setPhone] = useState(a.patient.phone);
  const save = useMutation({
    mutationFn: () => api.completePatient(a.id, {
      name, sex, phone,
      ...(age.trim() !== "" ? { ageYears: Number(age) } : dob ? { dob } : {}),
    }),
    onSuccess: (x) => { updated(x); onDone(); },
  });
  const errs = save.error instanceof ApiError ? save.error.fields : {};
  return (
    <form className="flex flex-col gap-3 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} autoFocus />
        <Segmented<Sex> label="Sex" name="reg-sex" value={sex} onChange={setSex}
          options={[{ value: "M", label: "Male" }, { value: "F", label: "Female" }, { value: "O", label: "Other" }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age in years" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))} error={errs.ageYears} />
          <Field label="or date of birth" type="date" value={dob} onChange={(e) => setDob(e.target.value)} error={errs.dob} />
        </div>
        <Field label="Mobile" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errs.phone} />
      </div>
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>Save details</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
      <p className="text-xs text-ink-3">The patient keeps the same ID ({a.patient.uhid}). If they turn out to be registered already, note the old ID in the chart.</p>
    </form>
  );
}

/** Medico-legal case details; the police intimation number often arrives after admission. */
export function MlcEditor({ admission: a, onDone }: { admission: Admission; onDone: () => void }) {
  const updated = useAdmissionUpdate();
  const [mlc, setMlc] = useState(true);
  const [no, setNo] = useState(a.mlc?.no ?? "");
  const [policeStation, setPoliceStation] = useState(a.mlc?.policeStation ?? "");
  const [broughtBy, setBroughtBy] = useState(a.mlc?.broughtBy ?? "");
  const save = useMutation({
    mutationFn: () => api.setMlc(a.id, { mlc, mlcNo: no, policeStation, broughtBy }),
    onSuccess: (x) => { updated(x); onDone(); },
  });
  const errs = save.error instanceof ApiError ? save.error.fields : {};
  return (
    <form className="flex flex-col gap-3 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="size-4" checked={mlc} onChange={(e) => setMlc(e.target.checked)} />
        <span className="font-medium">Medico-legal case</span>
      </label>
      {mlc && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="MLC / intimation number" value={no} onChange={(e) => setNo(e.target.value)} error={errs.mlcNo} autoFocus />
          <Field label="Police station informed" value={policeStation} onChange={(e) => setPoliceStation(e.target.value)} error={errs.policeStation} />
          <Field label="Brought by" value={broughtBy} onChange={(e) => setBroughtBy(e.target.value)} error={errs.broughtBy} />
        </div>
      )}
      {save.error && !Object.keys(errs).length && <Alert tone="danger">{save.error.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>Save</Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
