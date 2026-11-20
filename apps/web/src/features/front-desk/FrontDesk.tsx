import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ageLabel, formatINR, type Patient, type Receipt } from "@hs/shared";
import { api, timeLabel } from "../../lib/api";
import { Card, StepHeader } from "../../components/ui";
import { PatientStep } from "./PatientStep";
import { DoctorStep, rememberDoctor } from "./DoctorStep";
import { BillStep } from "./BillStep";
import { ReceiptView } from "./ReceiptView";
import { QueuePanel } from "../queue/QueuePanel";

type Step = "patient" | "doctor" | "bill" | "done";

/**
 * The front desk on one screen, with no page changes: Patient → Doctor & time → Bill.
 * Finished steps collapse into a one-line summary with "Change", so the context stays visible and
 * every earlier choice is one click away. Target: a returning patient in about 4 keystrokes.
 */
export function FrontDesk() {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("patient");
  const [patient, setPatient] = useState<Patient>();
  const [doctorId, setDoctorId] = useState<string>();
  const [slotStart, setSlotStart] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [receipt, setReceipt] = useState<Receipt>();
  const doctors = useQuery({ queryKey: ["practitioners"], queryFn: api.practitioners, staleTime: 60_000 });
  const doctor = doctors.data?.find((d) => d.id === doctorId);

  const onDoctorChange = useCallback((id: string, slot?: string) => {
    setDoctorId(id);
    setSlotStart(slot);
  }, []);

  const reset = () => {
    setStep("patient");
    setPatient(undefined);
    setSlotStart(undefined);
    setNotice(undefined);
    setReceipt(undefined);
    // Keep doctorId: the next patient is usually for the same doctor.
  };

  return (
    <div className="mx-auto grid max-w-[1400px] gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:p-6">
      <div className="flex min-w-0 flex-col gap-3">
        <Card className="p-4 lg:p-5" aria-labelledby="s1">
          <div id="s1">
            <StepHeader
              n={1}
              title="Patient"
              done={!!patient}
              summary={
                patient && (
                  <span>
                    <b className="text-ink">{patient.name}</b> · {patient.sex} · {patient.dobEstimated ? "~" : ""}{ageLabel(patient.dob)} · {patient.phone} · {patient.uhid}
                  </span>
                )
              }
              onEdit={patient && step !== "done" ? () => setStep("patient") : undefined}
            />
          </div>
          {step === "patient" && (
            <div className="mt-4">
              <PatientStep
                onSelect={(p) => {
                  setPatient(p);
                  setStep("doctor");
                }}
              />
            </div>
          )}
        </Card>

        <Card className="p-4 lg:p-5" aria-labelledby="s2">
          <div id="s2">
            <StepHeader
              n={2}
              title="Doctor & time"
              done={step === "bill" || step === "done"}
              summary={
                (step === "bill" || step === "done") && doctor && slotStart && (
                  <span><b className="text-ink">{doctor.name}</b> · today {timeLabel(slotStart)} · {formatINR(doctor.consultationFee)}</span>
                )
              }
              onEdit={step === "bill" ? () => setStep("doctor") : undefined}
            />
          </div>
          {step === "doctor" && (
            <div className="mt-4">
              <DoctorStep
                doctorId={doctorId}
                slotStart={slotStart}
                notice={notice}
                onChange={onDoctorChange}
                onContinue={() => {
                  if (!doctorId || !slotStart) return;
                  rememberDoctor(doctorId);
                  setNotice(undefined);
                  setStep("bill");
                }}
              />
            </div>
          )}
        </Card>

        <Card className="p-4 lg:p-5" aria-labelledby="s3">
          <div id="s3">
            <StepHeader n={3} title="Bill & payment" done={step === "done"} />
          </div>
          {step === "bill" && patient && doctor && slotStart && (
            <div className="mt-4">
              <BillStep
                patientId={patient.id}
                doctor={doctor}
                slotStart={slotStart}
                onPaid={(r) => {
                  setReceipt(r);
                  setStep("done");
                  void qc.invalidateQueries({ queryKey: ["queue"] });
                  void qc.invalidateQueries({ queryKey: ["slots"] });
                }}
                onSlotTaken={(msg) => {
                  setNotice(msg);
                  setSlotStart(undefined); // DoctorStep picks the next free slot
                  void qc.invalidateQueries({ queryKey: ["slots"] });
                  setStep("doctor");
                }}
              />
            </div>
          )}
          {step === "done" && receipt && (
            <div className="mt-4">
              <ReceiptView receipt={receipt} onNext={reset} />
            </div>
          )}
        </Card>
      </div>

      <QueuePanel />
    </div>
  );
}
