import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Stethoscope, NotebookPen, FlaskConical, Pill, BedDouble, Wifi, WifiOff, Users, Lock, LogOut, KeyRound, ChevronDown, Settings, Network, Wallet } from "lucide-react";
import { ROLE_LABEL, type Permission } from "@ojas/shared";
import { api } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useServerEvents } from "./lib/realtime";
import { useHotkeys } from "./lib/hotkeys";
import { FrontDesk } from "./features/front-desk/FrontDesk";
import { QueueBoard } from "./features/queue/QueueBoard";
import { ConsultPage } from "./features/consult/ConsultPage";
import { PharmacyPage } from "./features/pharmacy/PharmacyPage";
import { LabPage } from "./features/lab/LabPage";
import { IpdPage } from "./features/ipd/IpdPage";
import { DayEndPage } from "./features/reports/DayEndPage";
import { UsersPage } from "./features/admin/UsersPage";
import { SettingsPage, type SettingsTab } from "./features/settings/SettingsPage";
import { BackupBanner } from "./features/backup/BackupBanner";
import { CredentialsForm } from "./features/auth/AuthScreens";
import { Kbd, cx } from "./components/ui";

type Page = "front-desk" | "queue" | "consult" | "pharmacy" | "lab" | "ipd" | "day-end" | "settings" | "users";

/** Each page appears only for roles that can use it. */
const nav: { id: Page; label: string; icon: typeof ClipboardList; key: string; perm?: Permission | Permission[] }[] = [
  { id: "front-desk", label: "Front desk", icon: ClipboardList, key: "Alt+1", perm: "appointments.book" },
  { id: "consult", label: "Consultation", icon: NotebookPen, key: "Alt+3", perm: "consult.write" },
  { id: "queue", label: "OPD queue", icon: Stethoscope, key: "Alt+2" },
  { id: "lab", label: "Laboratory", icon: FlaskConical, key: "Alt+5", perm: ["lab.order", "lab.collect", "lab.result", "lab.verify", "lab.tests"] },
  { id: "pharmacy", label: "Pharmacy", icon: Pill, key: "Alt+4", perm: ["pharmacy.sell", "pharmacy.stock", "pharmacy.purchase", "pharmacy.reports"] },
  { id: "ipd", label: "In-patients", icon: BedDouble, key: "Alt+6", perm: "ipd.read" },
  { id: "day-end", label: "Day end", icon: Wallet, key: "Alt+7", perm: "billing.report" },
  { id: "settings", label: "Settings", icon: Settings, key: "Alt+8", perm: "settings.manage" },
  { id: "users", label: "Users", icon: Users, key: "Alt+9", perm: "users.manage" },
];

export function App() {
  const { can, lock } = useAuth();
  const pages = nav.filter((n) => !n.perm || [n.perm].flat().some((p) => can(p)));
  const [page, setPage] = useState<Page>(pages[0]!.id);
  const [settingsTab, setSettingsTab] = useState<{ tab: SettingsTab; n: number }>({ tab: "doctors", n: 0 });
  const openBackups = () => {
    setSettingsTab((t) => ({ tab: "backups", n: t.n + 1 })); // remounts Settings on the Backups tab
    setPage("settings");
  };
  const connection = useServerEvents();
  const facility = useQuery({ queryKey: ["facility"], queryFn: api.facility, staleTime: Infinity });
  useHotkeys({
    ...Object.fromEntries(pages.map((n) => [n.key, () => setPage(n.id)])),
    "Ctrl+L": () => void lock(),
  });

  return (
    <div className="flex min-h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">
        Skip to main content
      </a>
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-surface/95 px-4 backdrop-blur lg:px-6">
        <div className="flex min-w-0 shrink items-center gap-2 font-bold">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden>
            +
          </span>
          <span className="hidden max-w-48 truncate whitespace-nowrap md:inline" title={facility.data?.name}>{facility.data?.name ?? "Ojas"}</span>
        </div>
        <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {pages.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={page === n.id ? "page" : undefined}
              aria-keyshortcuts={n.key}
              title={`${n.label} (${n.key})`}
              aria-label={n.label}
              onClick={() => setPage(n.id)}
              className={cx(
                "flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium",
                page === n.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <n.icon aria-hidden className="size-4" />
              <span className="hidden xl:inline">{n.label}</span>
              <span className="hidden 2xl:inline"><Kbd>{n.key}</Kbd></span>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-sm">
          <ConnectionBadge state={connection} />
          <Clock />
          <UserMenu />
        </div>
      </header>
      {can("settings.manage") && <BackupBanner onOpen={openBackups} />}
      <main id="main" className="flex-1">
        {page === "front-desk" ? <FrontDesk /> : page === "consult" ? <ConsultPage /> : page === "pharmacy" ? <PharmacyPage /> : page === "lab" ? <LabPage /> : page === "ipd" ? <IpdPage /> : page === "day-end" ? <DayEndPage /> : page === "users" ? <UsersPage /> : page === "settings" ? <SettingsPage key={settingsTab.n} initialTab={settingsTab.tab} /> : <QueueBoard />}
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
    <time className="hidden whitespace-nowrap tabular-nums text-ink-2 lg:block" dateTime={now.toISOString()}>
      {now.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} ·{" "}
      {now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

function UserMenu() {
  const { user, lock, signOut, can } = useAuth();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!user) return null;
  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="flex min-h-9 items-center gap-2 rounded-lg px-2 hover:bg-surface-2"
      >
        <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent" aria-hidden>
          {user.displayName.slice(0, 1)}
        </span>
        <span className="hidden text-left leading-tight lg:block">
          <span className="block font-medium">{user.displayName}</span>
          <span className="block text-xs text-ink-2">{ROLE_LABEL[user.role]}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 text-ink-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-20 w-60 rounded-xl border border-line bg-surface p-1 shadow-card" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <div className="px-3 py-2 lg:hidden">
            <div className="font-medium">{user.displayName}</div>
            <div className="text-xs text-ink-2">{ROLE_LABEL[user.role]}</div>
          </div>
          <MenuItem icon={KeyRound} onClick={() => { setOpen(false); dialog.current?.showModal(); }}>My PIN & password</MenuItem>
          {window.ojas?.changeConnection && can("settings.manage") && (
            <MenuItem icon={Network} onClick={() => { setOpen(false); void window.ojas!.changeConnection!(); }}>This PC's connection…</MenuItem>
          )}
          <MenuItem icon={Lock} onClick={() => void lock()} hint="Ctrl+L">Lock desk</MenuItem>
          <MenuItem icon={LogOut} onClick={() => void signOut()}>Sign out</MenuItem>
        </div>
      )}
      <dialog ref={dialog} aria-labelledby="acct-title" className="m-auto w-full max-w-md rounded-2xl border border-line bg-surface p-6 text-ink backdrop:bg-black/50">
        <div className="mb-4 flex items-center">
          <h2 id="acct-title" className="text-lg font-bold">My PIN & password</h2>
          <button type="button" className="ml-auto rounded-md px-2 text-ink-2 hover:bg-surface-2" onClick={() => dialog.current?.close()} aria-label="Close">✕</button>
        </div>
        <CredentialsForm onDone={() => setTimeout(() => dialog.current?.close(), 800)} />
      </dialog>
    </div>
  );
}

function MenuItem({ icon: Icon, children, onClick, hint }: { icon: typeof Lock; children: React.ReactNode; onClick: () => void; hint?: string }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2">
      <Icon aria-hidden className="size-4 text-ink-2" />
      <span className="flex-1">{children}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </button>
  );
}
