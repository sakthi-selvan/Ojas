import { useState } from "react";
import { BedDouble, DoorOpen, History, Pill, Settings2, Siren } from "lucide-react";
import type { Permission } from "@ojas/shared";
import { useAuth } from "../../lib/auth";
import { cx } from "../../components/ui";
import { BedBoard } from "./BedBoard";
import { AdmitPanel } from "./AdmitPanel";
import { EmergencyPanel } from "./EmergencyPanel";
import { DischargedList } from "./DischargedList";
import { WardsPanel } from "./WardsPanel";
import { AdmissionView } from "./AdmissionView";
import { DoseRound } from "./DoseRound";

type Tab = "beds" | "doses" | "emergency" | "admit" | "discharged" | "wards";
/** A tab shows for anyone with one of its permissions. The doctor on duty can admit through casualty. */
const tabs: { id: Tab; label: string; icon: typeof BedDouble; perms: Permission[] }[] = [
  { id: "beds", label: "Beds", icon: BedDouble, perms: ["ipd.read"] },
  { id: "doses", label: "Doses", icon: Pill, perms: ["ipd.read"] },
  { id: "emergency", label: "Emergency", icon: Siren, perms: ["ipd.admit", "ipd.orders"] },
  { id: "admit", label: "Admit", icon: DoorOpen, perms: ["ipd.admit"] },
  { id: "discharged", label: "Discharged", icon: History, perms: ["ipd.read"] },
  { id: "wards", label: "Wards & charges", icon: Settings2, perms: ["ipd.setup"] },
];

/** In-patients: the bed board, admitting, recent discharges, and ward setup. Opening a patient shows their chart. */
export function IpdPage() {
  const { can } = useAuth();
  const shown = tabs.filter((t) => t.perms.some((p) => can(p)));
  const canEmergency = can("ipd.admit") || can("ipd.orders");
  const [tab, setTab] = useState<Tab>(shown[0]?.id ?? "beds");
  const [openId, setOpenId] = useState<string | null>(null);
  const [bedForAdmit, setBedForAdmit] = useState<string | null>(null);

  if (openId) return <AdmissionView id={openId} onClose={() => setOpenId(null)} />;
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
      <div role="tablist" aria-label="In-patients" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {shown.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`ipd-tab-${t.id}`}
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`ipd-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = shown.findIndex((x) => x.id === tab);
              const next = e.key === "ArrowRight" ? shown[(i + 1) % shown.length] : e.key === "ArrowLeft" ? shown[(i + shown.length - 1) % shown.length] : undefined;
              if (next) { setTab(next.id); document.getElementById(`ipd-tab-${next.id}`)?.focus(); }
            }}
            className={cx(
              "-mb-px flex min-h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
              tab === t.id ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <t.icon aria-hidden className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`ipd-panel-${tab}`} aria-labelledby={`ipd-tab-${tab}`}>
        {tab === "beds" && (
          <BedBoard
            onOpen={setOpenId}
            onAdmit={canEmergency ? (bedId, emergency) => {
              const to = emergency || !can("ipd.admit") ? "emergency" : "admit";
              setBedForAdmit(bedId);
              setTab(to);
            } : undefined}
            onSetup={can("ipd.setup") ? () => setTab("wards") : undefined}
          />
        )}
        {tab === "doses" && <DoseRound onOpen={setOpenId} />}
        {tab === "emergency" && <EmergencyPanel key={bedForAdmit ?? ""} initialBedId={bedForAdmit} onOpen={(id) => { setBedForAdmit(null); setOpenId(id); }} />}
        {tab === "admit" && <AdmitPanel key={bedForAdmit ?? ""} initialBedId={bedForAdmit} onOpen={(id) => { setBedForAdmit(null); setOpenId(id); }} />}
        {tab === "discharged" && <DischargedList onOpen={setOpenId} />}
        {tab === "wards" && <WardsPanel />}
      </div>
    </div>
  );
}
