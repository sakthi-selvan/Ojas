import { ageLabel, bmiOf, MED_TIMING_LABEL, type ConsultView, type Encounter, type Medication } from "@ojas/shared";
import { dateLabel, dateTimeLabel } from "../../lib/api";

/**
 * Prescriptions print on A5 paper (A4 also works), not the 80 mm receipt roll. The page size is
 * switched only while printing, and the desktop app shows the print dialog so the right printer
 * (not the receipt printer) is chosen.
 */
export async function printPrescription(): Promise<void> {
  const style = document.createElement("style");
  style.textContent = "@media print { @page { size: A5 portrait; margin: 10mm; } }";
  document.head.append(style);
  try {
    if (window.ojas) await window.ojas.print({ silent: false });
    else window.print();
  } finally {
    style.remove();
  }
}

/** "YYYY-MM-DD" of an instant in this PC's time zone (slot times are stored in UTC). */
export const localDay = (iso: string): string => new Date(iso).toLocaleDateString("en-CA");

export const medLine = (m: Medication): string =>
  [m.dose, m.frequency, MED_TIMING_LABEL[m.timing], m.durationDays ? `${m.durationDays} day${m.durationDays === 1 ? "" : "s"}` : "Continue"]
    .filter(Boolean)
    .join(" · ");

const sexLabel = { M: "Male", F: "Female", O: "Other" } as const;

/** The patient's copy: clinic and doctor letterhead, vitals, diagnosis, medicines, tests and advice. Prints only. */
export function PrintablePrescription({ view, encounter }: { view: ConsultView; encounter: Encounter }) {
  const { patient: p, practitioner: d, facility: f } = view;
  const v = encounter.vitals;
  const bmi = bmiOf(v);
  const vitals = [
    v.temperatureF != null && `Temp ${v.temperatureF} °F`,
    v.pulse != null && `Pulse ${v.pulse}/min`,
    v.bpSystolic != null && v.bpDiastolic != null && `BP ${v.bpSystolic}/${v.bpDiastolic} mmHg`,
    v.spo2 != null && `SpO₂ ${v.spo2}%`,
    v.respRate != null && `RR ${v.respRate}/min`,
    v.weightKg != null && `Wt ${v.weightKg} kg`,
    v.heightCm != null && `Ht ${v.heightCm} cm`,
    bmi != null && `BMI ${bmi}`,
    v.bloodSugar != null && `RBS ${v.bloodSugar} mg/dL`,
  ].filter(Boolean);

  return (
    <article className="print-area print-rx print-only text-[11pt] leading-snug text-black" aria-hidden>
      <header className="flex items-start justify-between gap-4 border-b-2 border-black pb-2">
        <div>
          <div className="text-[15pt] font-bold">{d.name}</div>
          {d.qualification && <div>{d.qualification}</div>}
          <div>{d.department}</div>
          {d.registrationNo && <div className="text-[9pt]">Reg. No. {d.registrationNo}</div>}
        </div>
        <div className="text-right text-[9pt]">
          <div className="text-[12pt] font-bold">{f.name}</div>
          <div>{f.address}</div>
          {f.phone && <div>Ph: {f.phone}</div>}
          {f.email && <div>{f.email}</div>}
        </div>
      </header>

      <section className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-black py-2 text-[10pt]">
        <div>
          <strong>{p.name}</strong> · {sexLabel[p.sex]}, {ageLabel(p.dob)} · {p.phone}
        </div>
        <div className="text-right">{dateLabel(localDay(view.slotStart))}</div>
        <div>UHID {p.uhid}</div>
        <div className="text-right">Token {view.token}</div>
      </section>

      {vitals.length > 0 && <p className="mt-2 text-[10pt]">{vitals.join(" · ")}</p>}
      {encounter.chiefComplaint && <p className="mt-2"><strong>Complaints:</strong> {encounter.chiefComplaint}</p>}
      {encounter.examination && <p className="mt-1"><strong>Findings:</strong> {encounter.examination}</p>}
      {encounter.diagnoses.length > 0 && (
        <p className="mt-1">
          <strong>Diagnosis:</strong> {encounter.diagnoses.map((x) => x.text + (x.code ? ` (${x.code})` : "")).join("; ")}
        </p>
      )}

      {encounter.medications.length > 0 && (
        <section className="mt-3">
          <div className="text-[16pt] font-bold italic leading-none">℞</div>
          <ol className="mt-1 flex flex-col gap-1.5">
            {encounter.medications.map((m, i) => (
              <li key={i} className="grid grid-cols-[1.5em_1fr]">
                <span>{i + 1}.</span>
                <div>
                  <div className="font-bold">{m.drug}</div>
                  <div className="text-[10pt]">{medLine(m)}{m.instructions ? ` · ${m.instructions}` : ""}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {encounter.labOrders.length > 0 && (
        <p className="mt-3"><strong>Tests:</strong> {encounter.labOrders.map((l) => l.test + (l.notes ? ` (${l.notes})` : "")).join(", ")}</p>
      )}
      {encounter.advice && <p className="mt-2 whitespace-pre-line"><strong>Advice:</strong> {encounter.advice}</p>}
      {encounter.followUpDate && <p className="mt-2"><strong>Review on:</strong> {dateLabel(encounter.followUpDate)}</p>}

      <footer className="mt-10 flex items-end justify-between text-[9pt]">
        <div>
          {encounter.signedAt ? `Signed ${dateTimeLabel(encounter.signedAt)}` : "Draft: not signed"}
          {encounter.version > 1 && ` · corrected (version ${encounter.version})`}
        </div>
        <div className="text-center">
          <div className="w-48 border-t border-black pt-1">{d.name}</div>
        </div>
      </footer>
    </article>
  );
}
