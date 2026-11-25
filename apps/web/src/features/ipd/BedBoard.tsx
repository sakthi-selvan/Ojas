import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BedDouble, CheckCircle2, Sparkles, UserRound } from "lucide-react";
import { WARD_KIND_LABEL, ageLabel, formatINR, midnightsBetween, type Bed, type Ward } from "@ojas/shared";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, cx } from "../../components/ui";

export const dayOfStay = (admittedAt: string, now = new Date()) => midnightsBetween(new Date(admittedAt), now).length + 1;

/** Every ward and bed at a glance: who is where, which beds are free, and which are being cleaned. */
export function BedBoard({ onOpen, onAdmit, onSetup }: { onOpen: (admissionId: string) => void; onAdmit?: (bedId: string) => void; onSetup?: () => void }) {
  const wards = useQuery({ queryKey: ["ipd-wards"], queryFn: () => api.wards() });
  if (wards.error) return <Alert tone="danger">{wards.error.message}</Alert>;
  if (!wards.data) return <p className="text-ink-3">Loading beds…</p>;
  if (!wards.data.length) {
    return (
      <Card className="flex flex-col items-start gap-3 p-6">
        <h2 className="text-lg font-semibold">No wards yet</h2>
        <p className="text-ink-2">Add the hospital's wards and beds, with the daily charge for each, before admitting patients.</p>
        {onSetup ? <Button variant="primary" onClick={onSetup}>Set up wards</Button> : <p className="text-sm text-ink-3">Ask an administrator to set them up.</p>}
      </Card>
    );
  }
  const beds = wards.data.flatMap((w) => w.beds);
  const count = (s: Bed["state"]) => beds.filter((b) => b.state === s).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 text-sm" role="status">
        <Badge tone="accent">{count("OCCUPIED")} occupied</Badge>
        <Badge tone="ok">{count("FREE")} free</Badge>
        {count("CLEANING") > 0 && <Badge tone="warn">{count("CLEANING")} being cleaned</Badge>}
        {beds.some((b) => b.occupant?.dischargeAdvised) && <Badge tone="neutral">{beds.filter((b) => b.occupant?.dischargeAdvised).length} ready to go home</Badge>}
      </div>
      {wards.data.map((w) => <WardCard key={w.id} ward={w} onOpen={onOpen} onAdmit={onAdmit} />)}
    </div>
  );
}

function WardCard({ ward: w, onOpen, onAdmit }: { ward: Ward; onOpen: (id: string) => void; onAdmit?: (bedId: string) => void }) {
  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby={`ward-${w.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 id={`ward-${w.id}`} className="text-lg font-semibold">{w.name}</h2>
        <span className="text-sm text-ink-3">{w.name.toLowerCase() === WARD_KIND_LABEL[w.kind].toLowerCase() ? "" : `${WARD_KIND_LABEL[w.kind]} · `}{formatINR(w.bedCharge)}/day{w.nursingCharge ? ` + nursing ${formatINR(w.nursingCharge)}` : ""}</span>
        <span className="ml-auto text-sm text-ink-3">{w.beds.filter((b) => b.state === "FREE").length} of {w.beds.length} free</span>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {w.beds.map((b) => <li key={b.id}><BedTile bed={b} onOpen={onOpen} onAdmit={onAdmit} /></li>)}
      </ul>
    </Card>
  );
}

function BedTile({ bed: b, onOpen, onAdmit }: { bed: Bed; onOpen: (id: string) => void; onAdmit?: (bedId: string) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const ready = useMutation({ mutationFn: () => api.bedReady(b.id), onSuccess: () => qc.invalidateQueries({ queryKey: ["ipd-wards"] }) });
  const base = "flex h-full min-h-24 w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm";
  if (b.occupant) {
    const o = b.occupant;
    return (
      <button type="button" onClick={() => onOpen(o.admissionId)} className={cx(base, "border-accent/40 bg-accent-soft/40 hover:bg-accent-soft")}>
        <span className="flex items-center gap-1.5 font-semibold"><BedDouble aria-hidden className="size-4 text-accent" /> {b.label}
          {o.dischargeAdvised && <span className="ml-auto"><Badge tone="ok">Going home</Badge></span>}
        </span>
        <span className="truncate font-semibold">{o.patientName}</span>
        <span className="truncate text-xs text-ink-2">{o.dob ? ageLabel(o.dob) : "—"} · {o.sex} · Day {dayOfStay(o.admittedAt)} · {o.doctorName}</span>
      </button>
    );
  }
  if (b.state === "CLEANING") {
    return (
      <div className={cx(base, "border-warn/40 bg-warn-soft/40")}>
        <span className="flex items-center gap-1.5 font-semibold"><Sparkles aria-hidden className="size-4 text-warn" /> {b.label}</span>
        <span className="text-ink-2">Being cleaned</span>
        {(can("ipd.chart") || can("ipd.admit")) && (
          <Button className="mt-auto min-h-8 px-2 text-xs" disabled={ready.isPending} onClick={() => ready.mutate()}>
            <CheckCircle2 aria-hidden className="size-3.5" /> Clean, ready
          </Button>
        )}
        {ready.error && <span className="text-xs text-danger">{ready.error.message}</span>}
      </div>
    );
  }
  return onAdmit ? (
    <button type="button" onClick={() => onAdmit(b.id)} className={cx(base, "border-dashed border-line hover:border-accent hover:bg-surface-2")}>
      <span className="flex items-center gap-1.5 font-semibold"><BedDouble aria-hidden className="size-4 text-ok" /> {b.label}</span>
      <span className="text-ok">Free</span>
      <span className="mt-auto flex items-center gap-1 text-xs text-ink-3"><UserRound aria-hidden className="size-3.5" /> Admit here</span>
    </button>
  ) : (
    <div className={cx(base, "border-dashed border-line")}>
      <span className="flex items-center gap-1.5 font-semibold"><BedDouble aria-hidden className="size-4 text-ok" /> {b.label}</span>
      <span className="text-ok">Free</span>
    </div>
  );
}
