import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DOSAGE_FORM_LABEL, expiryLabel, formatINR, itemLabel, type Item } from "@ojas/shared";
import { api } from "../../lib/api";
import { Badge, cx } from "../../components/ui";

export const scheduleBadge = (s: Item["schedule"]) => (s === "NONE" ? null : <Badge tone={s === "H" ? "warn" : "danger"}>{s === "H" ? "Sch. H" : s === "H1" ? "Sch. H1" : "Sch. X"}</Badge>);

/**
 * Find a medicine by name or generic name (ARIA combobox). Shows stock, price and the next
 * expiry so the pharmacist can see at a glance whether it can be sold.
 */
export const ItemSearch = forwardRef<HTMLInputElement, {
  label: string;
  onPick: (item: Item) => void;
  placeholder?: string;
  hideLabel?: boolean;
  /** Purchases list every active medicine; selling shows stock too. */
  showStock?: boolean;
  className?: string;
}>(function ItemSearch({ label, onPick, placeholder, hideLabel, showStock = true, className }, ref) {
  const id = useId();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const t = setTimeout(() => setTerm(text), 120);
    return () => clearTimeout(t);
  }, [text]);
  const list = useQuery({
    queryKey: ["pharmacy-items", term.trim().toLowerCase()],
    queryFn: () => api.pharmacyItems(term),
    enabled: open && term.trim().length >= 1,
    placeholderData: keepPreviousData,
  });
  const items = term.trim() ? (list.data ?? []) : [];
  const show = open && items.length > 0;
  const pick = (i: Item) => {
    onPick(i);
    setText("");
    setTerm("");
    setActive(0);
  };

  return (
    <div className={cx("relative flex flex-col gap-1", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "text-sm font-medium text-ink-2"}>{label}</label>
      <input
        ref={ref}
        id={id}
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={show ? `${id}-o${active}` : undefined}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => { clearTimeout(closing.current); setOpen(true); }}
        onBlur={() => { closing.current = setTimeout(() => setOpen(false), 120); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter" && show && items[active]) { e.preventDefault(); pick(items[active]!); }
          else if (e.key === "Escape" && show) { e.stopPropagation(); setOpen(false); }
        }}
        className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-3"
      />
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label={`${label} results`} className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-card">
          {items.map((i, n) => {
            const out = showStock && i.onHand === 0;
            return (
              <li
                key={i.id}
                id={`${id}-o${n}`}
                role="option"
                aria-selected={n === active}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}
                onMouseEnter={() => setActive(n)}
                className={cx("flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm", n === active && "bg-accent-soft", out && "opacity-60")}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{itemLabel(i)}</span>
                    {scheduleBadge(i.schedule)}
                    {!i.active && <Badge>Not sold</Badge>}
                  </span>
                  <span className="block truncate text-xs text-ink-3">
                    {DOSAGE_FORM_LABEL[i.form]} · pack of {i.packSize}{i.generic ? ` · ${i.generic}` : ""}{i.manufacturer ? ` · ${i.manufacturer}` : ""}
                  </span>
                </span>
                {showStock && (
                  <span className="shrink-0 text-right text-xs tabular-nums">
                    <span className={cx("block font-semibold", out ? "text-danger" : "text-ink")}>{out ? "Out of stock" : `${i.onHand} in stock`}</span>
                    {i.mrpPerPack != null && <span className="block text-ink-3">{formatINR(i.mrpPerPack)}/pack{i.nextExpiry ? ` · exp ${expiryLabel(i.nextExpiry)}` : ""}</span>}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
