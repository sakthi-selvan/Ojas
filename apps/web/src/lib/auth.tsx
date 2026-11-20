import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can as roleCan, type AuthStatus, type Permission, type SessionUser } from "@ojas/shared";
import { api, SESSION_ENDED } from "./api";

// ───────────────────────── Recent users on this desk ─────────────────────────
// The lock screen shows "who's at the desk?" tiles for people who recently signed in on this PC,
// so switching user is a tap and a PIN. Only IDs are stored locally; names come from the server.
const RECENT_KEY = "ojas.recentUsers";

export function recentUserIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function rememberUser(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentUserIds().filter((x) => x !== id)].slice(0, 8)));
  } catch { /* storage unavailable */ }
}
export function forgetUser(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentUserIds().filter((x) => x !== id)));
  } catch { /* ignore */ }
}

// ───────────────────────── Context ─────────────────────────

interface AuthContextValue {
  status: AuthStatus | undefined;
  loading: boolean;
  error: Error | null;
  user: SessionUser | null;
  /** The user whose session was locked (idle or Ctrl+L), so the lock screen can ask just for their PIN. */
  lockedUserId: string | undefined;
  can: (p: Permission) => boolean;
  signedIn: (u: SessionUser) => void;
  lock: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Desks lock themselves after this much inactivity (sessions also expire server-side after 30 min). */
const IDLE_LOCK_MS = 5 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["auth"], queryFn: api.authStatus, staleTime: Infinity, retry: 1 });
  const [lockedUserId, setLockedUserId] = useState<string>();
  const user = q.data?.user ?? null;

  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["auth"] }), [qc]);

  const signedIn = useCallback(
    (u: SessionUser) => {
      rememberUser(u.id);
      setLockedUserId(undefined);
      // Never show one user's cached data to the next person at the desk.
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
      qc.setQueryData<AuthStatus>(["auth"], { needsSetup: false, user: u });
    },
    [qc],
  );

  const endSession = useCallback(
    async (keepAsLocked: boolean) => {
      const current = qc.getQueryData<AuthStatus>(["auth"])?.user;
      try {
        await api.logout();
      } catch { /* already ended server-side */ }
      setLockedUserId(keepAsLocked ? current?.id : undefined);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
      qc.setQueryData<AuthStatus>(["auth"], { needsSetup: false, user: null });
    },
    [qc],
  );
  const lock = useCallback(() => endSession(true), [endSession]);
  const signOut = useCallback(() => endSession(false), [endSession]);

  // Server says the session ended (idle timeout, deactivated, password changed elsewhere).
  useEffect(() => {
    const onEnded = () => {
      const current = qc.getQueryData<AuthStatus>(["auth"])?.user;
      if (current) setLockedUserId(current.id);
      refresh();
    };
    window.addEventListener(SESSION_ENDED, onEnded);
    return () => window.removeEventListener(SESSION_ENDED, onEnded);
  }, [qc, refresh]);

  useIdle(IDLE_LOCK_MS, !!user && !user.mustChangePassword, lock);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: q.data, loading: q.isLoading, error: q.error, user, lockedUserId,
      can: (p) => roleCan(user?.role, p), signedIn, lock, signOut, refresh,
    }),
    [q.data, q.isLoading, q.error, user, lockedUserId, signedIn, lock, signOut, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** Calls `onIdle` after `ms` without keyboard, mouse or touch input. */
function useIdle(ms: number, enabled: boolean, onIdle: () => void) {
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    if (!enabled) return;
    let timer = setTimeout(() => cb.current(), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), ms);
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [ms, enabled]);
}
