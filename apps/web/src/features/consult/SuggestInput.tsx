import { forwardRef, useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Suggestion, SuggestionKind } from "@ojas/shared";
import { api } from "../../lib/api";
import { cx } from "../../components/ui";

/**
 * Text box with suggestions from what this clinic has written before (ARIA combobox).
 * Arrow keys move, Enter picks the highlighted one (or keeps what was typed), Escape closes.
 */
export const SuggestInput = forwardRef<HTMLInputElement, {
  kind: SuggestionKind;
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Called with the picked suggestion, or with just the typed text when Enter is pressed on no suggestion. */
  onPick: (s: Suggestion) => void;
  placeholder?: string;
  className?: string;
  hideLabel?: boolean;
}>(function SuggestInput({ kind, label, value, onChange, onPick, placeholder, className, hideLabel }, ref) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [term, setTerm] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setTerm(value), 150);
    return () => clearTimeout(t);
  }, [value]);
  const list = useQuery({
    queryKey: ["suggest", kind, term.trim().toLowerCase()],
    queryFn: () => api.suggestions(kind, term),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const items = (list.data ?? []).filter((s) => s.text.toLowerCase() !== value.trim().toLowerCase() || s.med || s.code);
  const show = open && items.length > 0;

  const pick = (s: Suggestion) => {
    onPick(s);
    setOpen(false);
    setActive(-1);
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
        aria-activedescendant={show && active >= 0 ? `${id}-o${active}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const s = show && active >= 0 ? items[active] : undefined;
            if (s) pick(s);
            else if (value.trim()) pick({ text: value.trim(), uses: 0 });
          } else if (e.key === "Escape" && show) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-3"
      />
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`} className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-card">
          {items.map((s, i) => (
            <li
              key={s.text + i}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cx("flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm", i === active && "bg-accent-soft")}
            >
              <span className="font-medium">{s.text}</span>
              {s.code && <span className="text-xs text-ink-3">{s.code}</span>}
              {s.med && <span className="truncate text-xs text-ink-3">{[s.med.dose, s.med.frequency, s.med.durationDays ? `${s.med.durationDays} d` : ""].filter(Boolean).join(" · ")}</span>}
              {s.uses > 1 && <span className="ml-auto shrink-0 text-xs text-ink-3">{s.uses}×</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
