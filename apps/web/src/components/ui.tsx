import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

/** Keyboard shortcut hint. Every primary action shows its key, so staff learn shortcuts by just using the screen. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex min-w-5 items-center justify-center rounded border border-current/25 px-1 font-sans text-[11px] font-semibold leading-4 opacity-80", className)}>
      {children}
    </kbd>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110 shadow-card",
  secondary: "bg-surface text-ink border border-line hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "bg-danger text-white hover:brightness-110",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "md" | "lg"; shortcut?: string }>(
  function Button({ variant = "secondary", size = "md", shortcut, className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-keyshortcuts={shortcut}
        className={cx(
          "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
          size === "lg" ? "min-h-12 px-5 text-base" : "min-h-10 px-3.5 text-sm",
          variants[variant],
          className,
        )}
        {...rest}
      >
        {children}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </button>
    );
  },
);

/** Label + input + help/error text, wired up with the right ARIA attributes. */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }>(
  function Field({ label, error, hint, className, id, ...rest }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    const msgId = `${inputId}-msg`;
    return (
      <div className={cx("flex flex-col gap-1", className)}>
        <label htmlFor={inputId} className="text-sm font-medium text-ink-2">
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? msgId : undefined}
          className={cx(
            "min-h-11 rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-ink-3",
            error ? "border-danger" : "border-line",
          )}
          {...rest}
        />
        {(error || hint) && (
          <p id={msgId} className={cx("text-sm", error ? "text-danger" : "text-ink-3")}>
            {error ?? hint}
          </p>
        )}
      </div>
    );
  },
);

/** Accessible radio group shown as a segmented control. Arrow keys move; each option can have a hotkey. */
export function Segmented<T extends string>({
  label, value, onChange, options, name,
}: {
  label: string;
  name: string;
  value: T | undefined;
  onChange: (v: T) => void;
  options: { value: T; label: string; key?: string; icon?: ReactNode }[];
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium text-ink-2">{label}</legend>
      <div className="inline-flex w-full rounded-lg border border-line bg-surface-2 p-1">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={cx(
                "flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus",
                checked ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
              )}
            >
              <input type="radio" className="sr-only" name={name} value={o.value} checked={checked} onChange={() => onChange(o.value)} />
              {o.icon}
              {o.label}
              {o.key && <Kbd>{o.key}</Kbd>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx("rounded-xl border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </section>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "accent" }) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
    accent: "bg-accent-soft text-accent",
  };
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold", tones[tone])}>{children}</span>;
}

/** Inline message. Errors are announced to screen readers immediately. */
export function Alert({ tone, children, action }: { tone: "danger" | "warn" | "ok"; children: ReactNode; action?: ReactNode }) {
  const tones = { danger: "bg-danger-soft text-danger border-danger/30", warn: "bg-warn-soft text-warn border-warn/30", ok: "bg-ok-soft text-ok border-ok/30" };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium", tones[tone])}>
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

export function StepHeader({ n, title, done, summary, onEdit }: { n: number; title: string; done?: boolean; summary?: ReactNode; onEdit?: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className={cx("grid size-7 place-items-center rounded-full text-sm font-bold", done ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2")}
      >
        {done ? "✓" : n}
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      {summary && <div className="min-w-0 flex-1 truncate text-sm text-ink-2">{summary}</div>}
      {onEdit && (
        <Button variant="ghost" onClick={onEdit} className="ml-auto">
          Change
        </Button>
      )}
    </div>
  );
}
