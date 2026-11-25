import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LAB_SECTION_LABEL, formatINR, type LabTest } from "@ojas/shared";
import { api } from "../../lib/api";
import { Badge, cx } from "../../components/ui";

/** Find a test by code, name or another name doctors use (ARIA combobox). */
export const TestSearch = forwardRef<HTMLInputElement, { label: string; onPick: (t: LabTest) => void; placeholder?: string; exclude?: string[] }>(
  function TestSearch({ label, onPick, placeholder, exclude = [] }, ref) {
    const id = useId();
    const [text, setText] = useState("");
    const [term, setTerm] = useState("");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
      const t = setTimeout(() => setTerm(text.trim()), 100);
      return () => clearTimeout(t);
    }, [text]);
    const list = useQuery({ queryKey: ["lab-tests", term.toLowerCase()], queryFn: () => api.labTests(term), enabled: open && term.length >= 1, placeholderData: keepPreviousData });
    const items = term ? (list.data ?? []).filter((t) => !exclude.includes(t.id)) : [];
    const show = open && items.length > 0;
    const pick = (t: LabTest) => {
      onPick(t);
      setText("");
      setTerm("");
      setActive(0);
    };
    return (
      <div className="relative flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium text-ink-2">{label}</label>
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
            {items.map((t, n) => (
              <li
                key={t.id}
                id={`${id}-o${n}`}
                role="option"
                aria-selected={n === active}
                onMouseDown={(e) => { e.preventDefault(); pick(t); }}
                onMouseEnter={() => setActive(n)}
                className={cx("flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm", n === active && "bg-accent-soft")}
              >
                <span className="w-16 shrink-0 font-mono text-xs text-ink-3">{t.code}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{t.name}</span>
                  <span className="block truncate text-xs text-ink-3">{LAB_SECTION_LABEL[t.section]} · {t.parameters.length} parameter{t.parameters.length === 1 ? "" : "s"}</span>
                </span>
                {t.price > 0 ? <span className="shrink-0 tabular-nums">{formatINR(t.price)}</span> : <Badge tone="warn">No price</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
