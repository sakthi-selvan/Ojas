import { useState } from "react";
import { Building2, CalendarOff, Stethoscope } from "lucide-react";
import { Card, cx } from "../../components/ui";
import { ClinicForm } from "./ClinicForm";
import { DoctorsPanel } from "./DoctorsPanel";
import { HolidaysPanel } from "./HolidaysPanel";

type Tab = "doctors" | "holidays" | "clinic";
const tabs: { id: Tab; label: string; icon: typeof Building2 }[] = [
  { id: "doctors", label: "Doctors & timings", icon: Stethoscope },
  { id: "holidays", label: "Holidays & leave", icon: CalendarOff },
  { id: "clinic", label: "Clinic details", icon: Building2 },
];

/** Administrator settings. The most frequent changes (timings, leave) come first. */
export function SettingsPage() {
  const [tab, setTab] = useState<Tab>("doctors");
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Settings</h1>
        <span className="text-sm text-ink-2">Changes apply to new bookings. Past visits and bills never change.</span>
      </div>
      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            type="button"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.id === tab);
              const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : undefined;
              if (next) { setTab(next.id); document.getElementById(`tab-${next.id}`)?.focus(); }
            }}
            tabIndex={tab === t.id ? 0 : -1}
            className={cx(
              "-mb-px flex min-h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium",
              tab === t.id ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <t.icon aria-hidden className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "doctors" && <DoctorsPanel />}
        {tab === "holidays" && <HolidaysPanel />}
        {tab === "clinic" && <Card className="p-4 sm:p-6"><ClinicForm /></Card>}
      </div>
    </div>
  );
}
