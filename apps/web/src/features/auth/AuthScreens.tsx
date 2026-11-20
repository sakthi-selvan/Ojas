import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Delete, KeyRound, LogIn, ShieldCheck, UserRound } from "lucide-react";
import { ROLE_LABEL, type SessionUser, type UserTile } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { forgetUser, recentUserIds, useAuth } from "../../lib/auth";
import { Alert, Button, Field, Kbd, cx } from "../../components/ui";

/** Decides what to show: setup on a new install, sign-in, a forced password change, or the app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, loading, error, user, refresh } = useAuth();
  if (loading) return <Centered><p className="text-ink-3">Connecting to Ojas…</p></Centered>;
  if (error || !status) {
    return (
      <Centered>
        <Shell title="Can't reach the Ojas server">
          <Alert tone="danger">{(error as Error)?.message ?? "No response from the server"}</Alert>
          <Button variant="primary" onClick={refresh}>Try again</Button>
        </Shell>
      </Centered>
    );
  }
  if (status.needsSetup) return <SetupScreen />;
  if (!user) return <SignInScreen />;
  if (user.mustChangePassword) return <Centered><ForcedPasswordChange user={user} /></Centered>;
  return <>{children}</>;
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="grid min-h-full place-items-center bg-bg p-4">{children}</main>;
}

function Brand() {
  const facility = useQuery({ queryKey: ["facility-public"], queryFn: api.facility, retry: false, staleTime: Infinity });
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-ink" aria-hidden>
        +
      </span>
      <div>
        <div className="text-lg font-bold leading-tight">Ojas</div>
        <div className="text-sm text-ink-2">{facility.data?.name ?? "Healthcare suite"}</div>
      </div>
    </div>
  );
}

function Shell({ title, subtitle, children, wide }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={cx("w-full rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8", wide ? "max-w-2xl" : "max-w-md")} aria-labelledby="auth-title">
      <Brand />
      <h1 id="auth-title" className="text-xl font-bold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      <div className="mt-6 flex flex-col gap-4">{children}</div>
    </section>
  );
}

const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError ? e.fields : {});

// ───────────────────────── First run ─────────────────────────

function SetupScreen() {
  const { signedIn } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pin, setPin] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const setup = useMutation({ mutationFn: api.setup, onSuccess: signedIn });
  const errs = fieldErrors(setup.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMismatch(password !== confirm);
    if (password !== confirm) return;
    setup.mutate({ displayName, username, password, pin: pin || undefined });
  };

  return (
    <Centered>
      <Shell title="Welcome! Let's set up Ojas" subtitle="Create the administrator account. You'll add staff accounts after this." wide>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="Your name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={errs.displayName} autoComplete="name" />
          <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} error={errs.username} autoComplete="username" />
          <Field label="Password" type="password" hint="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} autoComplete="new-password" />
          <Field label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? "Passwords don't match" : undefined} autoComplete="new-password" />
          <Field label="Quick PIN (optional)" inputMode="numeric" type="password" hint="4–6 digits, for unlocking the desk quickly" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} error={errs.pin} autoComplete="off" />
          <div className="flex items-end">
            <Button type="submit" variant="primary" size="lg" className="w-full" disabled={setup.isPending}>
              <ShieldCheck aria-hidden className="size-5" /> {setup.isPending ? "Creating…" : "Create administrator"}
            </Button>
          </div>
          {setup.error && !Object.keys(errs).length && <div className="sm:col-span-2"><Alert tone="danger">{setup.error.message}</Alert></div>}
        </form>
      </Shell>
    </Centered>
  );
}

// ───────────────────────── Sign in ─────────────────────────

function SignInScreen() {
  const { lockedUserId } = useAuth();
  const ids = recentUserIds();
  const tiles = useQuery({ queryKey: ["auth-tiles", ids.join(",")], queryFn: () => api.tiles(ids), enabled: ids.length > 0, staleTime: 0 });
  const [chosen, setChosen] = useState<UserTile | null>(null);
  const [mode, setMode] = useState<"tiles" | "password">(ids.length ? "tiles" : "password");

  // A locked desk goes straight to the PIN of the person who was using it.
  useEffect(() => {
    if (!tiles.data) return;
    if (!tiles.data.length) setMode("password");
    const locked = tiles.data.find((t) => t.id === lockedUserId && t.hasPin);
    if (locked) setChosen(locked);
  }, [tiles.data, lockedUserId]);

  if (mode === "password" || (tiles.isSuccess && !tiles.data.length)) {
    return (
      <Centered>
        <Shell title="Sign in" subtitle={lockedUserId ? "This desk was locked to keep patient data private." : undefined}>
          <PasswordForm />
          {ids.length > 0 && tiles.data && tiles.data.length > 0 && (
            <Button variant="ghost" onClick={() => setMode("tiles")}>
              <UserRound aria-hidden className="size-4" /> Choose from recent users
            </Button>
          )}
        </Shell>
      </Centered>
    );
  }

  if (chosen) {
    return (
      <Centered>
        <Shell title={`Hi, ${chosen.displayName.split(" ")[0]}`} subtitle={chosen.id === lockedUserId ? "Desk locked. Enter your PIN to continue." : "Enter your PIN"}>
          <PinPad user={chosen} onBack={() => setChosen(null)} />
        </Shell>
      </Centered>
    );
  }

  return (
    <Centered>
      <Shell title="Who's at the desk?" subtitle="Pick your name to unlock with your PIN.">
        {tiles.isLoading && <p className="text-sm text-ink-3">Loading…</p>}
        <ul className="grid grid-cols-2 gap-2" aria-label="Recent users on this desk">
          {tiles.data?.map((t, i) => (
            <li key={t.id}>
              <button
                type="button"
                autoFocus={i === 0}
                onClick={() => (t.hasPin ? setChosen(t) : setMode("password"))}
                className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left hover:border-accent hover:bg-accent-soft"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 font-bold text-ink-2" aria-hidden>
                  {t.displayName.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{t.displayName}</span>
                  <span className="block truncate text-xs text-ink-2">{ROLE_LABEL[t.role]}{t.hasPin ? "" : " · password"}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" onClick={() => setMode("password")}>
          <KeyRound aria-hidden className="size-4" /> Someone else? Sign in with username & password
        </Button>
      </Shell>
    </Centered>
  );
}

function PasswordForm() {
  const { signedIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({ mutationFn: api.login, onSuccess: signedIn, onError: () => setPassword("") });
  const errs = fieldErrors(login.error);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate({ username, password });
      }}
      noValidate
    >
      <Field label="Username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} error={errs.username} autoComplete="username" autoCapitalize="none" spellCheck={false} />
      <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} autoComplete="current-password" />
      {login.error && !Object.keys(errs).length && <Alert tone="danger">{login.error.message}</Alert>}
      <Button type="submit" variant="primary" size="lg" disabled={login.isPending || !username || !password}>
        <LogIn aria-hidden className="size-5" /> {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

/** Big touch-friendly PIN pad that also accepts the keyboard's number keys. */
function PinPad({ user, onBack }: { user: UserTile; onBack: () => void }) {
  const { signedIn } = useAuth();
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const login = useMutation({
    mutationFn: () => api.pinLogin({ userId: user.id, pin }),
    onSuccess: signedIn,
    onError: (e) => {
      setPin("");
      // The person no longer exists here or was deactivated: drop their tile from this desk.
      if (e instanceof ApiError && e.status === 404) forgetUser(user.id);
      inputRef.current?.focus();
    },
  });
  const press = (d: string) => setPin((p) => (p.length < 6 ? p + d : p));
  const submit = () => pin.length >= 4 && !login.isPending && login.mutate();

  return (
    <form
      className="flex flex-col items-center gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="pin">PIN for {user.displayName}</label>
      <input
        ref={inputRef}
        id="pin"
        autoFocus
        inputMode="numeric"
        type="password"
        autoComplete="off"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        onKeyDown={(e) => e.key === "Escape" && onBack()}
        className="h-14 w-56 rounded-xl border border-line bg-surface text-center text-3xl tracking-[0.5em] text-ink"
        aria-describedby={login.error ? "pin-err" : undefined}
      />
      {login.error && <p id="pin-err" role="alert" className="text-sm font-medium text-danger">{login.error.message}</p>}
      <div className="grid grid-cols-3 gap-2" aria-hidden>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <PadKey key={d} onClick={() => press(d)}>{d}</PadKey>
        ))}
        <PadKey onClick={() => setPin((p) => p.slice(0, -1))} label="Delete"><Delete className="size-5" /></PadKey>
        <PadKey onClick={() => press("0")}>0</PadKey>
        <PadKey onClick={submit} primary label="Unlock">✓</PadKey>
      </div>
      <div className="flex w-full justify-between">
        <Button variant="ghost" onClick={onBack} shortcut="Esc">Not you?</Button>
        <Button type="submit" variant="primary" disabled={pin.length < 4 || login.isPending}>
          {login.isPending ? "Checking…" : "Unlock"} <Kbd>Enter</Kbd>
        </Button>
      </div>
    </form>
  );
}

function PadKey({ children, onClick, primary, label }: { children: ReactNode; onClick: () => void; primary?: boolean; label?: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onClick={onClick}
      className={cx("grid size-16 place-items-center rounded-xl text-xl font-semibold", primary ? "bg-accent text-accent-ink" : "bg-surface-2 hover:bg-line")}
    >
      {children}
    </button>
  );
}

// ───────────────────────── Password & PIN ─────────────────────────

/** Change password and/or PIN. Used for the forced first-login change and from "My account". */
export function CredentialsForm({ forced, onDone }: { forced?: boolean; onDone?: (u: SessionUser) => void }) {
  const { signedIn } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pin, setPin] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: api.changeCredentials,
    onSuccess: (u) => {
      signedIn(u);
      onDone?.(u);
    },
  });
  const errs = { ...fieldErrors(save.error), ...local };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const l: Record<string, string> = {};
    if (forced && !next) l.newPassword = "Choose a new password";
    if (next && next !== confirm) l.confirm = "Passwords don't match";
    if (!forced && !next && !pin) l.newPin = "Enter a new password or PIN";
    setLocal(l);
    if (Object.keys(l).length) return;
    save.mutate({ currentPassword: current, newPassword: next || undefined, newPin: pin || undefined });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Field label={forced ? "Temporary password" : "Current password"} type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} error={errs.currentPassword} autoComplete="current-password" />
      <Field label="New password" type="password" hint={forced ? "At least 8 characters" : "Leave empty to keep your password"} value={next} onChange={(e) => setNext(e.target.value)} error={errs.newPassword} autoComplete="new-password" />
      {next && <Field label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errs.confirm} autoComplete="new-password" />}
      <Field label="Quick PIN" inputMode="numeric" type="password" hint="4–6 digits to unlock this desk quickly" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} error={errs.newPin} autoComplete="off" />
      {save.error && !Object.keys(fieldErrors(save.error)).length && <Alert tone="danger">{save.error.message}</Alert>}
      {save.isSuccess && !forced && <Alert tone="ok">Saved.</Alert>}
      <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
    </form>
  );
}

function ForcedPasswordChange({ user }: { user: SessionUser }) {
  const { signOut } = useAuth();
  return (
    <Shell title={`Welcome, ${user.displayName.split(" ")[0]}`} subtitle="Your administrator gave you a temporary password. Choose your own password and a quick PIN to continue.">
      <CredentialsForm forced />
      <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
    </Shell>
  );
}
