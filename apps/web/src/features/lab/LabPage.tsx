import { useState } from "react";
import { FlaskConical, ListChecks, Receipt } from "lucide-react";
import type { Permission } from "@ojas/shared";
import { useAuth } from "../../lib/auth";
import { cx } from "../../components/ui";
import { Worklist } from "./Worklist";
import { OrderPanel } from "./OrderPanel";
import { TestsPanel } from "./TestsPanel";

type Tab = "worklist" | "order" | "tests";
const tabs: { id: Tab; label: string; icon: typeof FlaskConical; perm: Permission }[] = [
  { id: "worklist", label: "Worklist", icon: ListChecks, perm: "lab.read" },
  { id: "order", label: "New order", icon: Receipt, perm: "lab.order" },
  { id: "tests", label: "Tests & prices", icon: FlaskConical, perm: "lab.tests" },
];

export function LabPage() {
  const { can } = useAuth();
  const shown = tabs.filter((t) => can(t.perm));
  const [tab, setTab] = useState<Tab>(shown[0]?.id ?? "order");
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
      <div role="tablist" aria-label="Laboratory" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {shown.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`lab-tab-${t.id}`}
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`lab-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = shown.findIndex((x) => x.id === tab);
              const next = e.key === "ArrowRight" ? shown[(i + 1) % shown.length] : e.key === "ArrowLeft" ? shown[(i + shown.length - 1) % shown.length] : undefined;
              if (next) { setTab(next.id); document.getElementById(`lab-tab-${next.id}`)?.focus(); }
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
      <div role="tabpanel" id={`lab-panel-${tab}`} aria-labelledby={`lab-tab-${tab}`}>
        {tab === "worklist" && <Worklist openId={openId} onOpen={setOpenId} />}
        {tab === "order" && <OrderPanel onOpenOrder={(id) => { setOpenId(id); setTab("worklist"); }} />}
        {tab === "tests" && <TestsPanel />}
      </div>
    </div>
  );
}
