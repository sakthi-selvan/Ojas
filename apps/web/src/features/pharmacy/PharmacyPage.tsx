import { useState } from "react";
import { BookLock, Boxes, Pill, ShoppingCart, Truck } from "lucide-react";
import type { Permission } from "@ojas/shared";
import { useAuth } from "../../lib/auth";
import { cx } from "../../components/ui";
import { SellPanel } from "./SellPanel";
import { PurchasePanel } from "./PurchasePanel";
import { StockPanel } from "./StockPanel";
import { MedicinesPanel } from "./MedicinesPanel";
import { RegisterPanel } from "./RegisterPanel";

type Tab = "sell" | "stock" | "purchases" | "medicines" | "register";
const tabs: { id: Tab; label: string; icon: typeof Pill; perm: Permission }[] = [
  { id: "sell", label: "Sell", icon: ShoppingCart, perm: "pharmacy.sell" },
  { id: "stock", label: "Stock & expiry", icon: Boxes, perm: "pharmacy.stock" },
  { id: "purchases", label: "Purchases", icon: Truck, perm: "pharmacy.purchase" },
  { id: "medicines", label: "Medicines", icon: Pill, perm: "pharmacy.stock" },
  { id: "register", label: "Schedule H1 register", icon: BookLock, perm: "pharmacy.reports" },
];

export function PharmacyPage() {
  const { can } = useAuth();
  const shown = tabs.filter((t) => can(t.perm));
  const [tab, setTab] = useState<Tab>(shown[0]?.id ?? "sell");
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
      <div role="tablist" aria-label="Pharmacy" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {shown.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`ph-tab-${t.id}`}
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`ph-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = shown.findIndex((x) => x.id === tab);
              const next = e.key === "ArrowRight" ? shown[(i + 1) % shown.length] : e.key === "ArrowLeft" ? shown[(i + shown.length - 1) % shown.length] : undefined;
              if (next) { setTab(next.id); document.getElementById(`ph-tab-${next.id}`)?.focus(); }
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
      <div role="tabpanel" id={`ph-panel-${tab}`} aria-labelledby={`ph-tab-${tab}`}>
        {tab === "sell" && <SellPanel />}
        {tab === "stock" && <StockPanel />}
        {tab === "purchases" && <PurchasePanel />}
        {tab === "medicines" && <MedicinesPanel />}
        {tab === "register" && <RegisterPanel />}
      </div>
    </div>
  );
}
