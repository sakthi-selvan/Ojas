import { useEffect, useRef } from "react";

/**
 * Global keyboard shortcuts. Combos are written like "F9", "Alt+N", "Ctrl+K", "Escape".
 * Function keys and modifier combos work even while typing in a field; plain keys only fire
 * when focus is not in a text input (so typing "1" in the phone box never changes payment mode).
 */
export function useHotkeys(map: Record<string, ((e: KeyboardEvent) => void) | false | undefined>) {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean);
      const combo = parts.join("+");
      const handler = ref.current[combo];
      if (!handler) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && (t as HTMLInputElement).type !== "radio";
      const isPlain = !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.key) && e.key !== "Escape";
      if (typing && isPlain) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
