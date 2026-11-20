import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Stethoscope, FlaskConical, Pill, BedDouble, Wifi, WifiOff } from "lucide-react";
import { api } from "./lib/api";
import { useServerEvents } from "./lib/realtime";
import { useHotkeys } from "./lib/hotkeys";
import { FrontDesk } from "./features/front-desk/FrontDesk";
import { QueueBoard } from "./features/queue/QueueBoard";
import { Kbd, cx } from "./components/ui";

type Page = "front-desk" | "queue";

const nav: { id: Page; label: string; icon: typeof ClipboardList; key: string }[] = [
  { id: "front-desk", label: "Front desk", icon: ClipboardList, key: "Alt+1" },
  { id: "queue", label: "OPD queue", icon: Stethoscope, key: "Alt+2" },
];

/** Upcoming modules are shown, but clearly disabled, so the product roadmap is visible without confusing anyone. */
const upcoming = [
  { label: "Laboratory", icon: FlaskConical },
  { label: "Pharmacy", icon: Pill },
  { label: "In-patients", icon: BedDouble },
];

export function App() {
  const [page, setPage] = useState<Page>("front-desk");
  const connection = useServerEvents();
  const facility = useQuery({ queryKey: ["facility"], queryFn: api.facility, staleTime: Infinity });
  useHotkeys({ "Alt+1": () => setPage("front-desk"), "Alt+2": () => setPage("queue") });

  return (
    <div className="flex min-h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">
        Skip to main content
      </a>
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-surface/95 px-4 backdrop-blur lg:px-6">
        <div className="flex items-center gap-2 font-bold">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden>
            +
          </span>
          <span className="hidden sm:inline">{facility.data?.name ?? "Ojas"}</span>
        </div>
        <nav aria-label="Main" className="flex items-center gap-1">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={page === n.id ? "page" : undefined}
              aria-keyshortcuts={n.key}
              onClick={() => setPage(n.id)}
              className={cx(
                "flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium",
                page === n.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <n.icon aria-hidden className="size-4" />
              {n.label}
              <Kbd className="hidden xl:inline-flex">{n.key}</Kbd>
            </button>
          ))}
          {upcoming.map((u) => (
            <span key={u.label} className="hidden items-center gap-2 whitespace-nowrap px-3 text-sm text-ink-3 xl:flex" title="Coming soon" aria-disabled>
              <u.icon aria-hidden className="size-4" />
              {u.label}
            </span>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <ConnectionBadge state={connection} />
          <Clock />
        </div>
      </header>
      <main id="main" className="flex-1">
        {page === "front-desk" ? <FrontDesk /> : <QueueBoard />}
      </main>
    </div>
  );
}

function ConnectionBadge({ state }: { state: ReturnType<typeof useServerEvents> }) {
  const online = state === "online";
  return (
    <span role="status" className={cx("flex items-center gap-1.5 whitespace-nowrap font-medium", online ? "text-ok" : "text-danger")}>
      {online ? <Wifi aria-hidden className="size-4" /> : <WifiOff aria-hidden className="size-4" />}
      <span className={online ? "sr-only md:not-sr-only" : undefined}>{online ? "Connected" : state === "connecting" ? "Connecting…" : "Server offline: retrying"}</span>
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="hidden whitespace-nowrap tabular-nums text-ink-2 sm:block" dateTime={now.toISOString()}>
      {now.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} ·{" "}
      {now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}
