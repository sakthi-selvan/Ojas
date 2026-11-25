import type {
  Admission, AdmissionSummary, AdmitInput, AmendSummaryInput, EmergencyAdmitInput, MlcInput, PatientDetailsInput, Inpatient, WardMeds, ChargeInput, DepositInput, DoseInput, IpdService, MedOrderInput, NoteInput, ServiceInput, SettleInput,
  SummaryInput, TransferInput, Ward, WardInput,
  AmendInput, CollectInput, LabBillInput, LabOrderDetail, LabOrderSummary, LabRequest, LabTest, OrderTest, PatientLabResult, RejectSampleInput, ResultsInput, TestInput,
  CheckoutInput, CancelBillInput, DayReport, Patient, PatientSearchResult, Practitioner, QueueItem, QuickRegisterInput, Receipt, DaySlots, AppointmentStatus,
  SystemInfo, BackupStatus, BackupConfigInput, BackupRun, BackupFile, RestoreInput, RestoreResult,
  Facility, FacilityInput, PublicFacility, PractitionerInput, Holiday, HolidayInput, Leave, LeaveInput,
  ConsultView, Encounter, PastVisit, Suggestion, SuggestionKind, VitalsInput, ConsultNotesInput,
  Item, ItemInput, Supplier, SupplierInput, PurchaseInput, PurchaseSummary, Batch, AdjustInput, StockAlerts, SaleInput, PharmacyBill,
  SaleSummary, RegisterEntry, PendingPrescription,
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
  facility: () => request<PublicFacility>("GET", "/facility"),
  searchPatients: (q: string) => request<PatientSearchResult[]>("GET", `/patients/search?q=${encodeURIComponent(q)}`),
  registerPatient: (input: QuickRegisterInput, force = false) => request<Patient>("POST", `/patients${force ? "?force=true" : ""}`, input),
  practitioners: () => request<Practitioner[]>("GET", "/practitioners"),
  slots: (practitionerId: string, date: string) => request<DaySlots>("GET", `/practitioners/${practitionerId}/slots?date=${date}`),
  checkout: (input: CheckoutInput) => request<Receipt>("POST", "/front-desk/checkout", input),
  receipt: (invoiceId: string) => request<Receipt>("GET", `/invoices/${invoiceId}/receipt`),
  cancelBill: (invoiceId: string, input: CancelBillInput) => request<Receipt>("POST", `/invoices/${invoiceId}/cancel`, input),
  dayReport: (date: string) => request<DayReport>("GET", `/reports/day?date=${date}`),
  queue: (date: string) => request<QueueItem[]>("GET", `/queue?date=${date}`),
  setStatus: (appointmentId: string, status: AppointmentStatus) => request<{ ok: true }>("PATCH", `/appointments/${appointmentId}/status`, { status }),

  // OPD consultation
  consult: (appointmentId: string) => request<ConsultView>("GET", `/consult/${appointmentId}`),
  consultHistory: (appointmentId: string) => request<PastVisit[]>("GET", `/consult/${appointmentId}/history`),
  saveVitals: (appointmentId: string, input: VitalsInput) => request<Encounter>("PUT", `/consult/${appointmentId}/vitals`, input),
  saveNotes: (appointmentId: string, input: ConsultNotesInput) => request<Encounter>("PUT", `/consult/${appointmentId}/notes`, input),
  signConsult: (appointmentId: string) => request<Encounter>("POST", `/consult/${appointmentId}/sign`),
  reopenConsult: (appointmentId: string, reason: string) => request<Encounter>("POST", `/consult/${appointmentId}/reopen`, { reason }),
  suggestions: (kind: SuggestionKind, q: string) => request<Suggestion[]>("GET", `/consult/suggestions?kind=${kind}&q=${encodeURIComponent(q)}`),

  // Pharmacy
  pharmacyItems: (q = "", opts: { all?: boolean; inStock?: boolean } = {}) =>
    request<Item[]>("GET", `/pharmacy/items?q=${encodeURIComponent(q)}${opts.all ? "&all=true" : ""}${opts.inStock ? "&inStock=true" : ""}`),
  createItem: (input: ItemInput) => request<Item>("POST", "/pharmacy/items", input),
  updateItem: (id: string, input: ItemInput) => request<Item>("PUT", `/pharmacy/items/${id}`, input),
  batches: (itemId: string) => request<Batch[]>("GET", `/pharmacy/items/${itemId}/batches`),
  suppliers: () => request<Supplier[]>("GET", "/pharmacy/suppliers"),
  createSupplier: (input: SupplierInput) => request<Supplier>("POST", "/pharmacy/suppliers", input),
  purchases: () => request<PurchaseSummary[]>("GET", "/pharmacy/purchases"),
  receivePurchase: (input: PurchaseInput) => request<PurchaseSummary>("POST", "/pharmacy/purchases", input),
  stockAlerts: () => request<StockAlerts>("GET", "/pharmacy/stock/alerts"),
  adjustStock: (input: AdjustInput) => request<Batch>("POST", "/pharmacy/stock/adjust", input),
  pendingPrescriptions: () => request<PendingPrescription[]>("GET", "/pharmacy/prescriptions"),
  sell: (input: SaleInput) => request<PharmacyBill>("POST", "/pharmacy/sales", input),
  sales: (date: string) => request<SaleSummary[]>("GET", `/pharmacy/sales?date=${date}`),
  bill: (id: string) => request<PharmacyBill>("GET", `/pharmacy/sales/${id}`),
  register: (from: string, to: string, schedules: string) => request<RegisterEntry[]>("GET", `/pharmacy/register?from=${from}&to=${to}&schedule=${schedules}`),
  labTests: (q = "", opts: { all?: boolean } = {}) => request<LabTest[]>("GET", `/lab/tests?q=${encodeURIComponent(q)}${opts.all ? "&all=true" : ""}`),
  createLabTest: (input: TestInput) => request<LabTest>("POST", "/lab/tests", input),
  updateLabTest: (id: string, input: TestInput) => request<LabTest>("PUT", `/lab/tests/${id}`, input),
  addStarterTests: () => request<{ added: number; skipped: number }>("POST", "/lab/tests/starter"),
  addChildRanges: () => request<{ tests: number; parameters: number }>("POST", "/lab/tests/child-ranges", {}),
  labRequests: () => request<LabRequest[]>("GET", "/lab/requests"),
  billLab: (input: LabBillInput) => request<LabOrderDetail>("POST", "/lab/orders", input),
  labOrders: (date: string) => request<LabOrderSummary[]>("GET", `/lab/orders?date=${date}`),
  labOrder: (id: string) => request<LabOrderDetail>("GET", `/lab/orders/${id}`),
  collectSamples: (orderId: string, input: CollectInput = {}) => request<LabOrderDetail>("POST", `/lab/orders/${orderId}/collect`, input),
  rejectSample: (sampleId: string, input: RejectSampleInput) => request<LabOrderDetail>("POST", `/lab/samples/${sampleId}/reject`, input),
  saveResults: (orderTestId: string, input: ResultsInput) => request<OrderTest>("PUT", `/lab/results/${orderTestId}`, input),
  verifyResult: (orderTestId: string, rowVersion: number) => request<OrderTest>("POST", `/lab/results/${orderTestId}/verify`, { rowVersion }),
  amendResult: (orderTestId: string, input: AmendInput) => request<OrderTest>("POST", `/lab/results/${orderTestId}/amend`, input),
  patientLabResults: (patientId: string) => request<PatientLabResult[]>("GET", `/lab/patients/${patientId}/results`),

  // In-patients
  wardDoses: () => request<WardMeds[]>("GET", "/ipd/doses"),
  inpatients: () => request<Inpatient[]>("GET", "/ipd/inpatients"),
  wards: (all = false) => request<Ward[]>("GET", `/ipd/wards${all ? "?all=true" : ""}`),
  createWard: (input: WardInput) => request<Ward>("POST", "/ipd/wards", input),
  updateWard: (id: string, input: WardInput) => request<Ward>("PUT", `/ipd/wards/${id}`, input),
  bedReady: (bedId: string) => request<void>("POST", `/ipd/beds/${bedId}/ready`, {}),
  ipdServices: (all = false) => request<IpdService[]>("GET", `/ipd/services${all ? "?all=true" : ""}`),
  createService: (input: ServiceInput) => request<IpdService>("POST", "/ipd/services", input),
  updateService: (id: string, input: ServiceInput) => request<IpdService>("PUT", `/ipd/services/${id}`, input),
  admissions: (status: "ADMITTED" | "DISCHARGED", q = "") => request<AdmissionSummary[]>("GET", `/ipd/admissions?status=${status}&q=${encodeURIComponent(q)}`),
  admission: (id: string) => request<Admission>("GET", `/ipd/admissions/${id}`),
  amendSummary: (id: string, input: AmendSummaryInput) => request<Admission>("POST", `/ipd/admissions/${id}/summary/amend`, input),
  admit: (input: AdmitInput) => request<Admission>("POST", "/ipd/admissions", input),
  admitEmergency: (input: EmergencyAdmitInput) => request<Admission>("POST", "/ipd/emergency", input),
  setMlc: (id: string, input: MlcInput) => request<Admission>("PUT", `/ipd/admissions/${id}/mlc`, input),
  completePatient: (id: string, input: PatientDetailsInput) => request<Admission>("POST", `/ipd/admissions/${id}/patient`, input),
  transfer: (id: string, input: TransferInput) => request<Admission>("POST", `/ipd/admissions/${id}/transfer`, input),
  addNote: (id: string, input: NoteInput) => request<Admission>("POST", `/ipd/admissions/${id}/notes`, input),
  addIpdVitals: (id: string, input: VitalsInput) => request<Admission>("POST", `/ipd/admissions/${id}/vitals`, input),
  addMed: (id: string, input: MedOrderInput) => request<Admission>("POST", `/ipd/admissions/${id}/meds`, input),
  stopMed: (medId: string, reason: string) => request<Admission>("POST", `/ipd/meds/${medId}/stop`, { reason }),
  recordDose: (medId: string, input: DoseInput) => request<Admission>("POST", `/ipd/meds/${medId}/doses`, input),
  addCharge: (id: string, input: ChargeInput) => request<Admission>("POST", `/ipd/admissions/${id}/charges`, input),
  cancelCharge: (chargeId: string, reason: string) => request<Admission>("POST", `/ipd/charges/${chargeId}/cancel`, { reason }),
  addDeposit: (id: string, input: DepositInput) => request<Admission>("POST", `/ipd/admissions/${id}/deposits`, input),
  saveSummary: (id: string, input: SummaryInput) => request<Admission>("PUT", `/ipd/admissions/${id}/summary`, input),
  signSummary: (id: string, summaryVersion: number) => request<Admission>("POST", `/ipd/admissions/${id}/summary/sign`, { summaryVersion }),
  discharge: (id: string, input: SettleInput) => request<Admission>("POST", `/ipd/admissions/${id}/discharge`, input),

  // Auth
  authStatus: () => request<AuthStatus>("GET", "/auth/status"),
  setup: (input: SetupInput) => request<SessionUser>("POST", "/auth/setup", input),
  login: (input: LoginInput) => request<SessionUser>("POST", "/auth/login", input),
  pinLogin: (input: PinLoginInput) => request<SessionUser>("POST", "/auth/pin", input),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  tiles: (ids: string[]) => request<UserTile[]>("POST", "/auth/tiles", { ids }),
  changeCredentials: (input: ChangeCredentialsInput) => request<SessionUser>("POST", "/auth/credentials", input),

  // Settings (administrator)
  settingsFacility: () => request<Facility>("GET", "/settings/facility"),
  saveFacility: (input: FacilityInput) => request<Facility>("PUT", "/settings/facility", input),
  completeSetup: () => request<Facility>("POST", "/settings/complete-setup"),
  allPractitioners: () => request<Practitioner[]>("GET", "/settings/practitioners"),
  createPractitioner: (input: PractitionerInput) => request<Practitioner>("POST", "/settings/practitioners", input),
  updatePractitioner: (id: string, input: PractitionerInput) => request<Practitioner>("PUT", `/settings/practitioners/${id}`, input),
  holidays: () => request<Holiday[]>("GET", "/settings/holidays"),
  addHoliday: (input: HolidayInput) => request<{ holiday: Holiday; bookedPatients: number }>("POST", "/settings/holidays", input),
  deleteHoliday: (date: string) => request<{ ok: true }>("DELETE", `/settings/holidays/${date}`),
  leaves: () => request<Leave[]>("GET", "/settings/leaves"),
  addLeave: (input: LeaveInput) => request<{ leave: Leave; bookedPatients: number }>("POST", "/settings/leaves", input),
  deleteLeave: (id: string) => request<{ ok: true }>("DELETE", `/settings/leaves/${id}`),

  systemInfo: () => request<SystemInfo>("GET", "/system/info"),

  // Backups (administrator)
  backupStatus: () => request<BackupStatus>("GET", "/backups/status"),
  saveBackupConfig: (input: BackupConfigInput) => request<BackupStatus>("PUT", "/backups/config", input),
  backupNow: () => request<BackupRun>("POST", "/backups/run"),
  backupRuns: () => request<BackupRun[]>("GET", "/backups/runs"),
  backupFiles: (folder?: string) => request<BackupFile[]>("GET", `/backups/files${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  restore: (input: RestoreInput) => request<RestoreResult>("POST", "/backups/restore", input),
  // Before first-run setup (disaster recovery on a new PC)
  setupBackupFiles: (folder?: string) => request<BackupFile[]>("GET", `/setup/backups${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`),
  setupRestore: (input: RestoreInput) => request<RestoreResult>("POST", "/setup/restore", input),

  // Users
  users: () => request<UserSummary[]>("GET", "/users"),
  createUser: (input: CreateUserInput) => request<UserSummary>("POST", "/users", input),
  updateUser: (id: string, input: UpdateUserInput) => request<UserSummary>("PATCH", `/users/${id}`, input),
};

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "Mon, 24 Nov 2026" for an ISO date, read in local time. */
export const dateLabel = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** "3 hours ago", "2 days ago", "just now". */
export const agoLabel = (iso: string, now = Date.now()): string => {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
};

export const sizeLabel = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** "20 Nov 2026, 2:30 pm" */
export const dateTimeLabel = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

export const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
