import type {
  CheckoutInput, Patient, PatientSearchResult, Practitioner, QueueItem, QuickRegisterInput, Receipt, Slot, AppointmentStatus,
  AuthStatus, SessionUser, LoginInput, PinLoginInput, SetupInput, ChangeCredentialsInput, UserTile, UserSummary, CreateUserInput, UpdateUserInput,
} from "@ojas/shared";

/** Fired when the server says the session is gone (signed out elsewhere, idle timeout, deactivated). */
export const SESSION_ENDED = "ojas:session-ended";

/** Error shape returned by the server: a stable code plus a message written for the user. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
  get fields(): Record<string, string> {
    return ((this.details as { fields?: Record<string, string> })?.fields) ?? {};
  }
}

/** Stable per-PC terminal id, so the audit trail shows *which* desk did what. */
function terminalId(): string {
  try {
    let id = localStorage.getItem("ojas.terminal");
    if (!id) localStorage.setItem("ojas.terminal", (id = `T-${crypto.randomUUID().slice(0, 8)}`));
    return id;
  } catch {
    return "T-unknown";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      // content-type only with a body: an empty JSON body is a 400 in Fastify (and broke logout once).
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-ojas-terminal": terminalId() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "Can't reach the Ojas server. Check the network cable or that the server PC is on.");
  }
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const d = data as { code?: string; message?: string; details?: unknown } | undefined;
    if ((res.status === 401 && d?.code === "not_signed_in") || d?.code === "password_change_required") {
      window.dispatchEvent(new Event(SESSION_ENDED));
    }
    throw new ApiError(res.status, d?.code ?? "error", d?.message ?? `Request failed (${res.status})`, d?.details);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; engine: string; serverTime: string }>("GET", "/health"),
  facility: () => request<{ name: string; address: string; phone: string }>("GET", "/facility"),
  searchPatients: (q: string) => request<PatientSearchResult[]>("GET", `/patients/search?q=${encodeURIComponent(q)}`),
  registerPatient: (input: QuickRegisterInput, force = false) => request<Patient>("POST", `/patients${force ? "?force=true" : ""}`, input),
  practitioners: () => request<Practitioner[]>("GET", "/practitioners"),
  slots: (practitionerId: string, date: string) => request<Slot[]>("GET", `/practitioners/${practitionerId}/slots?date=${date}`),
  checkout: (input: CheckoutInput) => request<Receipt>("POST", "/front-desk/checkout", input),
  receipt: (invoiceId: string) => request<Receipt>("GET", `/invoices/${invoiceId}/receipt`),
  queue: (date: string) => request<QueueItem[]>("GET", `/queue?date=${date}`),
  setStatus: (appointmentId: string, status: AppointmentStatus) => request<{ ok: true }>("PATCH", `/appointments/${appointmentId}/status`, { status }),

  // Auth
  authStatus: () => request<AuthStatus>("GET", "/auth/status"),
  setup: (input: SetupInput) => request<SessionUser>("POST", "/auth/setup", input),
  login: (input: LoginInput) => request<SessionUser>("POST", "/auth/login", input),
  pinLogin: (input: PinLoginInput) => request<SessionUser>("POST", "/auth/pin", input),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  tiles: (ids: string[]) => request<UserTile[]>("POST", "/auth/tiles", { ids }),
  changeCredentials: (input: ChangeCredentialsInput) => request<SessionUser>("POST", "/auth/credentials", input),

  // Users
  users: () => request<UserSummary[]>("GET", "/users"),
  createUser: (input: CreateUserInput) => request<UserSummary>("POST", "/users", input),
  updateUser: (id: string, input: UpdateUserInput) => request<UserSummary>("PATCH", `/users/${id}`, input),
};

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
