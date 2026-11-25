import { useEffect, useState, type ReactNode } from "react";

/** Paper sizes the app prints on. Receipts and labels go straight to their own printer; A4 asks which printer. */
export type Paper = "A4" | "receipt" | "label";
const PAGE: Record<Paper, string> = {
  A4: "@page { size: A4 portrait; margin: 12mm; }",
  receipt: "@page { size: 80mm auto; margin: 4mm; }",
  label: "@page { size: 50mm 25mm; margin: 0; }",
};

/**
 * Prints one job at a time: renders it (only while printing, so only it reaches the printer),
 * sets the page size, prints, then removes it.
 */
export function usePrintJob<J>(render: (job: J) => ReactNode, paperOf: (job: J) => Paper) {
  const [job, setJob] = useState<J | null>(null);
  useEffect(() => {
    if (job == null) return;
    const paper = paperOf(job);
    const style = document.createElement("style");
    style.textContent = `@media print { ${PAGE[paper]} }`;
    document.head.append(style);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      style.remove();
      setJob(null);
    };
    // Let React paint the printable first.
    const t = setTimeout(() => {
      if (window.ojas) void window.ojas.print({ silent: paper !== "A4" }).finally(finish);
      else { window.print(); finish(); }
    }, 50);
    return () => clearTimeout(t);
  }, [job]);
  return { print: setJob, view: job == null ? null : render(job) };
}
