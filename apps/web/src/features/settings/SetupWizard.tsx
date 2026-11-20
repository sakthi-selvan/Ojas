import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, LogOut } from "lucide-react";
import { formatINR } from "@ojas/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Button, Card, cx } from "../../components/ui";
import { ClinicForm } from "./ClinicForm";
import { DoctorsPanel, scheduleSummary } from "./DoctorsPanel";

const STEPS = ["Clinic details", "Doctors & timings", "Ready"] as const;

/**
 * First run, right after the administrator account is created: three short steps, so the front
 * desk opens with the real clinic name and real doctors instead of demo data.
 */
export function SetupWizard() {
  const qc = useQueryClient();
  const { user, signOut } = useAuth();
  const [step, setStep] = useState(0);
  const doctors = useQuery({ queryKey: ["settings-practitioners"], queryFn: api.allPractitioners });
  const facility = useQuery({ queryKey: ["settings-facility"], queryFn: api.settingsFacility });
  const finish = useMutation({
    mutationFn: api.completeSetup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["facility"] }),
  });
  const active = doctors.data?.filter((d) => d.active) ?? [];

  return (
    <main className="min-h-full bg-bg p-4 lg:p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-ink" aria-hidden>+</span>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Set up your clinic</h1>
            <p className="text-sm text-ink-2">About 3 minutes. Everything here can be changed later in Settings.</p>
          </div>
          <Button variant="ghost" onClick={() => void signOut()}><LogOut aria-hidden className="size-4" /> Sign out</Button>
        </header>

        <ol className="grid grid-cols-3 gap-2" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className="flex flex-col gap-1.5">
              <span className={cx("h-1.5 rounded-full", i <= step ? "bg-accent" : "bg-line")} />
              <span className={cx("text-sm", i === step ? "font-semibold text-ink" : "text-ink-3")}>
                {i + 1}. {s}
              </span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <Card className="p-4 sm:p-6">
            <h2 className="mb-1 text-lg font-semibold">Your clinic</h2>
            <p className="mb-5 text-sm text-ink-2">This is printed at the top of every receipt.</p>
            <ClinicForm submitLabel="Save and continue" onSaved={() => setStep(1)} />
          </Card>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Doctors and consulting hours</h2>
              <p className="text-sm text-ink-2">The front desk can only book doctors added here, within their hours. Add the rest any time.</p>
            </div>
            <DoctorsPanel />
            <div className="flex gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setStep(0)}><ArrowLeft aria-hidden className="size-4" /> Back</Button>
              <Button variant="primary" className="ml-auto" disabled={!active.length} onClick={() => setStep(2)}>
                Continue <ArrowRight aria-hidden className="size-4" />
              </Button>
            </div>
            {!active.length && doctors.isSuccess && <p className="text-right text-sm text-ink-3">Add at least one doctor to continue.</p>}
          </div>
        )}

        {step === 2 && (
          <Card className="flex flex-col gap-5 p-4 sm:p-6">
            <div className="flex items-center gap-3 text-ok">
              <CheckCircle2 aria-hidden className="size-7" />
              <h2 className="text-lg font-semibold text-ink">{facility.data?.name} is ready</h2>
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-ink-3">Address</dt><dd>{facility.data?.address || "—"}</dd>
              <dt className="text-ink-3">Patient IDs</dt><dd>{facility.data?.uhidPrefix}000001, {facility.data?.uhidPrefix}000002, …</dd>
              <dt className="text-ink-3">Doctors</dt>
              <dd className="flex flex-col gap-1">
                {active.map((d) => (
                  <span key={d.id}><span className="font-medium">{d.name}</span> · {formatINR(d.consultationFee)} · <span className="text-ink-2">{scheduleSummary(d.sessions)}</span></span>
                ))}
              </dd>
            </dl>
            <Alert tone="ok">
              Next, {user?.displayName.split(" ")[0]}: add your staff under <strong>Users</strong> so each receptionist signs in with their own PIN,
              and mark holidays under <strong>Settings → Holidays &amp; leave</strong>.
            </Alert>
            {finish.error && <Alert tone="danger">{finish.error.message}</Alert>}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft aria-hidden className="size-4" /> Back</Button>
              <Button variant="primary" size="lg" className="ml-auto" autoFocus disabled={finish.isPending} onClick={() => finish.mutate()}>
                {finish.isPending ? "Opening…" : "Open the front desk"} <ArrowRight aria-hidden className="size-5" />
              </Button>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
