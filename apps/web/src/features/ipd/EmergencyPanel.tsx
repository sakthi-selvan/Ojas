import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Siren } from "lucide-react";
import { formatINR, type Admission, type Patient, type Sex } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useHotkeys } from "../../lib/hotkeys";
import { Alert, Button, Card, Field, Segmented, Select } from "../../components/ui";
import { PatientStep } from "../front-desk/PatientStep";
import { Admitted } from "./AdmitPanel";
import { ageSex } from "./common";

const DOCTOR_KEY = "ojas.er.doctor";
const readDoctor = () => { try { return localStorage.getItem(DOCTOR_KEY) ?? ""; } catch { return ""; } };
const saveDoctor = (id: string) => { try { localStorage.setItem(DOCTOR_KEY, id); } catch { /* storage unavailable */ } };

type Who = "new" | "known";

/**
 * Casualty: admit first, register properly later. Only the sex, the complaint, the doctor on duty and
 * a bed are needed; no advance is taken. A medico-legal case records who brought the patient and the
 * police station. F9 admits.
 */
export function EmergencyPanel({ initialBedId, onOpen }: { initialBedId: string | null; onOpen: (admissionId: string) => void }) {
  const qc = useQueryClient();
  const [who, setWho] = useState<Who>("new");
  const [known, setKnown] = useState<Patient | null>(null);
  const [name, setName] = useState("");
  const [sex, setSex] = useState<Sex | undefined>(undefined);
  const [age, setAge] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [doctorId, setDoctorId] = useState(readDoctor);
  const [chosenBed, setBedId] = useState(initialBedId ?? "");
  const [broughtBy, setBroughtBy] = useState("");
  const [mlc, setMlc] = useState(false);
  const [policeStation, setPoliceStation] = useState("");
  const [mlcNo, setMlcNo] = useState("");
  const [attendant, setAttendant] = useState({ name: "", relation: "", phone: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Admission | null>(null);
  const idemKey = useRef(crypto.randomUUID());
  const wards = useQuery({ queryKey: ["ipd-wards"], queryFn: () => api.wards() });
  const doctors = useQuery({ queryKey: ["practitioners"], queryFn: api.practitioners });
  // Casualty beds first, then the rest; the first free casualty bed is picked unless one was chosen.
  const freeWards = (wards.data ?? [])
    .map((w) => ({ ...w, beds: w.beds.filter((b) => b.state === "FREE") }))
    .filter((w) => w.beds.length)
    .sort((a, b) => Number(b.kind === "EMERGENCY") - Number(a.kind === "EMERGENCY"));
  const bedId = chosenBed || (freeWards[0]?.kind === "EMERGENCY" ? freeWards[0].beds[0]!.id : "");
  const doctorKnown = doctors.data?.some((d) => d.id === doctorId);
  const fix = (...k: string[]) => setErrs((e) => Object.fromEntries(Object.entries(e).filter(([x]) => !k.includes(x))));

  const admit = useMutation({
    mutationFn: () => api.admitEmergency({
      ...(who === "known"
        ? { patientId: known!.id }
        : { newPatient: { name, sex: sex!, phone, ageYears: age.trim() === "" ? undefined : Number(age) } }),
      practitionerId: doctorKnown ? doctorId : "", bedId, reason,
      attendantName: attendant.name, attendantRelation: attendant.relation, attendantPhone: attendant.phone,
      broughtBy, mlc, mlcNo, policeStation, idempotencyKey: idemKey.current,
    }),
    onSuccess: (a) => {
      saveDoctor(a.doctor.id);
      setDone(a);
      void qc.invalidateQueries({ queryKey: ["ipd-wards"] });
      void qc.invalidateQueries({ queryKey: ["ipd-admissions"] });
    },
    onError: (e) => {
      setErrs(e instanceof ApiError ? e.fields : {});
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) idemKey.current = crypto.randomUUID();
    },
  });
  const submit = () => {
    if (done || admit.isPending) return;
    if (who === "known" && !known) return setErrs({ patientId: "Find the patient first" });
    if (who === "new" && !sex) return setErrs({ "newPatient.sex": "Choose male, female or other" });
    admit.mutate();
  };
  useHotkeys({ F9: submit });

  if (done) return <Admitted admission={done} onOpen={() => onOpen(done.id)} />;
  const fieldErrors = Object.keys(errs).length > 0;

  return (
    <Card className="mx-auto flex max-w-3xl flex-col gap-4 border-danger/40 p-4 sm:p-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-danger"><Siren aria-hidden className="size-5" /> Emergency admission</h2>
        <p className="text-sm text-ink-2">Treat first: no advance and no full registration. Complete the patient's details from their chart later.</p>
      </div>

      <Segmented<Who> label="Patient" name="er-who" value={who} onChange={(w) => { setWho(w); fix("patientId"); }}
        options={[{ value: "new", label: "New or unknown" }, { value: "known", label: "Already registered" }]} />

      {who === "known" ? (
        known ? (
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{known.name} <span className="font-normal text-ink-3">· {known.uhid}</span></div>
              <div className="text-sm text-ink-2">{ageSex(known)} · {known.phone}</div>
            </div>
            <Button variant="ghost" onClick={() => setKnown(null)}>Change</Button>
          </div>
        ) : (
          <>
            <PatientStep onSelect={(p) => { setKnown(p); fix("patientId"); }} />
            {errs.patientId && <Alert tone="danger">{errs.patientId}</Alert>}
          </>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
          <Field label="Name" value={name} placeholder="Leave blank if not known" autoFocus
            onChange={(e) => { setName(e.target.value); fix("newPatient.name"); }} error={errs["newPatient.name"]} />
          <div>
            <Segmented<Sex> label="Sex" name="er-sex" value={sex} onChange={(s) => { setSex(s); fix("newPatient.sex"); }}
              options={[{ value: "M", label: "Male" }, { value: "F", label: "Female" }, { value: "O", label: "Other" }]} />
            {errs["newPatient.sex"] && <p className="mt-1 text-sm text-danger">{errs["newPatient.sex"]}</p>}
          </div>
          <Field label="Age (about)" inputMode="numeric" value={age} placeholder="Not known"
            onChange={(e) => { setAge(e.target.value.replace(/\D/g, "")); fix("newPatient.ageYears"); }} error={errs["newPatient.ageYears"]} />
          <Field label="Mobile" inputMode="tel" value={phone} placeholder="If known"
            onChange={(e) => { setPhone(e.target.value); fix("newPatient.phone"); }} error={errs["newPatient.phone"]} />
        </div>
      )}

      <Field label="Complaint or injury" value={reason} placeholder="Road accident, chest pain, snake bite…" autoFocus={who === "known" && !!known}
        onChange={(e) => { setReason(e.target.value); fix("reason"); }} error={errs.reason} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Doctor on duty" value={doctorKnown ? doctorId : ""} onChange={(e) => { setDoctorId(e.target.value); fix("practitionerId"); }} error={errs.practitionerId}>
          <option value="">Choose…</option>
          {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.name}{d.department ? ` · ${d.department}` : ""}</option>)}
        </Select>
        <Select label="Bed" value={bedId} onChange={(e) => { setBedId(e.target.value); fix("bedId"); }} error={errs.bedId}
          hint={freeWards.length ? (freeWards[0]!.kind === "EMERGENCY" ? undefined : "No casualty bed free; any free bed will do") : "No free beds"}>
          <option value="">Choose…</option>
          {freeWards.map((w) => (
            <optgroup key={w.id} label={`${w.name} (${formatINR(w.bedCharge)}/day)`}>
              {w.beds.map((b) => <option key={b.id} value={b.id}>{w.name} · {b.label}</option>)}
            </optgroup>
          ))}
        </Select>
      </div>

      <Field label="Brought by" value={broughtBy} placeholder="Ambulance 108, a passer-by, family…" onChange={(e) => setBroughtBy(e.target.value)} error={errs.broughtBy} />
      <label className="flex items-start gap-3 rounded-lg border border-line p-3">
        <input type="checkbox" className="mt-1 size-4 accent-[var(--color-danger)]" checked={mlc} onChange={(e) => setMlc(e.target.checked)} />
        <span>
          <span className="font-medium">Medico-legal case (MLC)</span>
          <span className="block text-sm text-ink-3">Accident, assault, poisoning, burns, or an unexplained injury: the police must be told.</span>
        </span>
      </label>
      {mlc && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Police station informed" value={policeStation} onChange={(e) => setPoliceStation(e.target.value)} error={errs.policeStation} />
          <Field label="MLC / intimation number" value={mlcNo} placeholder="Can be added later" onChange={(e) => setMlcNo(e.target.value)} error={errs.mlcNo} />
        </div>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-[1fr_10rem_12rem]">
        <legend className="mb-1 text-sm font-medium text-ink-2">Attendant, if anyone is with them</legend>
        <Field label="Name" value={attendant.name} onChange={(e) => setAttendant((a) => ({ ...a, name: e.target.value }))} />
        <Field label="Relation" value={attendant.relation} onChange={(e) => setAttendant((a) => ({ ...a, relation: e.target.value }))} />
        <Field label="Mobile" inputMode="tel" value={attendant.phone} onChange={(e) => { setAttendant((a) => ({ ...a, phone: e.target.value })); fix("attendantPhone"); }} error={errs.attendantPhone} />
      </fieldset>

      {admit.error && !fieldErrors && <Alert tone="danger">{admit.error.message}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-sm text-ink-3">No advance is taken. Charges add up on the bill as usual.</span>
        <Button variant="danger" size="lg" shortcut="F9" disabled={admit.isPending} onClick={submit}>Admit now</Button>
      </div>
    </Card>
  );
}
