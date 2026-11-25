import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { APP_VERSION, can, type Permission, type ServerMode, type SystemInfo } from "@ojas/shared";
import type { Db } from "./db/index.js";
import type { Actor } from "./core/audit.js";
import { verifyAuditChain } from "./core/audit.js";
import { AppError } from "./core/errors.js";
import { isIsoDate, localDate } from "./core/clock.js";
import { Realtime } from "./realtime.js";
import { getPatient, quickRegister, searchPatients } from "./modules/front-desk/patients.js";
import { listPractitioners, slotsFor } from "./modules/front-desk/scheduling.js";
import { checkout, getReceipt } from "./modules/front-desk/checkout.js";
import { queueFor, setStatus } from "./modules/front-desk/queue.js";
import * as auth from "./modules/auth/service.js";
import * as settings from "./modules/settings/service.js";
import { BackupService } from "./modules/backup/service.js";
import * as consult from "./modules/consult/service.js";
import * as pharmacy from "./modules/pharmacy/catalog.js";
import * as pharmacyTx from "./modules/pharmacy/transactions.js";
import * as labCatalog from "./modules/lab/catalog.js";
import * as lab from "./modules/lab/orders.js";
import { DrugSchedule } from "@ojas/shared";

export interface AppOptions {
  db: Db;
  webDir?: string;
  logger?: boolean;
  /** Injected clock for tests. */
  now?: () => Date;
  /** Default folder for backups (used until the administrator picks one). */
  backupDir?: string;
  /** Server mode: serve HTTPS with this certificate (session cookie becomes Secure). */
  https?: { key: string; cert: string };
  /** What Settings → This server shows. */
  system?: { mode: ServerMode; port: number; serverCode: string | null };
}

declare module "fastify" {
  interface FastifyRequest {
    session: auth.SessionContext | null;
  }
  interface FastifyInstance {
    backups: BackupService;
  }
  interface FastifyContextConfig {
    /** Reachable without signing in (status, sign-in, first-run setup, health). */
    public?: boolean;
    /** Every listed permission is required. */
    perms?: Permission[];
    /** Allowed even while the user still has to change a temporary password. */
    duringPasswordChange?: boolean;
  }
}

export const SESSION_COOKIE = "ojas_session";

const dateParam = (v: unknown): string => {
  if (v === undefined) return localDate();
  if (!isIsoDate(v)) throw new AppError(400, "invalid_date", "Date must be YYYY-MM-DD");
  return v;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParam = (v: string): string => {
  if (!UUID.test(v)) throw new AppError(404, "not_found", "Not found");
  return v;
};

const terminalOf = (req: FastifyRequest) => String(req.headers["x-ojas-terminal"] ?? req.ip).slice(0, 64);

/** The signed-in user, as recorded in the audit trail. */
function actorOf(req: FastifyRequest): Actor {
  if (!req.session) throw new AppError(401, "not_signed_in", "Please sign in");
  return { user: req.session.user.username, terminal: terminalOf(req) };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  // Fastify's https and http instances have different generic types; the routes are identical.
  const app = Fastify({ logger: opts.logger ?? false, ...(opts.https ? { https: opts.https } : {}) }) as unknown as FastifyInstance;
  const realtime = new Realtime();
  const backups = new BackupService(db, {
    defaultDir: opts.backupDir ?? join(tmpdir(), "ojas-backups"),
    now,
    log: (msg, err) => (err ? app.log.error({ err }, msg) : app.log.info(msg)),
  });
  app.decorate("backups", backups);

  // No CORS: the UI is always served from the same origin (the Ojas server, or Vite's proxy in dev),
  // so no other web page can call this API.
  await app.register(cookie);
  // Accept an empty body with content-type: application/json (treated as {}), so an action like
  // "lock desk" can never fail just because a client sent the header without a body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body);
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, "bad_json", "The request was not valid JSON"), undefined);
    }
  });
  await app.register(websocket);

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/api",
      httpOnly: true, // page scripts can't read it
      sameSite: "strict", // other sites can't send it
      maxAge: Math.floor(auth.SESSION_MAX_MS / 1000),
      secure: !!opts.https, // over the clinic network the cookie only ever travels encrypted
    });

  app.decorateRequest("session", null);

  /**
   * One guard for every API route: who is signed in, may they call this, and is the request
   * really from our own UI? (Changes must carry the x-ojas-terminal header, which another site's
   * page cannot add without a CORS preflight that this server never approves.)
   */
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    const cfg = req.routeOptions.config;
    if (req.method !== "GET" && req.method !== "HEAD" && !req.headers["x-ojas-terminal"]) {
      throw new AppError(403, "missing_client_header", "Requests must come from the Ojas app");
    }
    req.session = await auth.resolveSession(db, req.cookies[SESSION_COOKIE], now());
    if (cfg.public) return;
    if (!req.session) throw new AppError(401, "not_signed_in", "Your session has ended. Please sign in again.");
    if (req.session.user.mustChangePassword && !cfg.duringPasswordChange) {
      throw new AppError(403, "password_change_required", "Please set a new password first");
    }
    for (const p of cfg.perms ?? []) {
      if (!can(req.session.user.role, p)) throw new AppError(403, "forbidden", "You don't have permission to do this. Ask an administrator.");
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const i of err.issues) fields[i.path.join(".") || "_"] ??= i.message;
      return reply.status(400).send({ code: "validation_failed", message: Object.values(fields)[0] ?? "Please check the form", details: { fields } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ code: "bad_request", message: e.message });
    app.log.error(err);
    return reply.status(500).send({ code: "internal", message: "Something went wrong. Your data is safe; please try again." });
  });

  const notifyQueue = (date: string) => realtime.broadcast({ type: "queue.changed", date });
  const pub = { config: { public: true } };
  const need = (...perms: Permission[]) => ({ config: { perms } });

  // ── System ──
  app.get("/api/health", pub, async () => ({ ok: true, engine: db.engine, serverTime: now().toISOString(), clients: realtime.size }));
  app.get("/api/events", { websocket: true }, (socket) => realtime.add(socket));
  app.get("/api/audit/verify", need("audit.verify"), async () => verifyAuditChain(db));
  app.get("/api/system/info", need("settings.manage"), async (): Promise<SystemInfo> => ({
    mode: opts.system?.mode ?? "standalone",
    tls: !!opts.https,
    port: opts.system?.port ?? 0,
    hostname: hostname(),
    addresses: Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i!.address),
    serverCode: opts.system?.serverCode ?? null,
    version: APP_VERSION,
  }));
  app.get("/api/facility", pub, async () => settings.publicFacility(db));

  // ── Auth ──
  app.get("/api/auth/status", pub, async (req) => auth.authStatus(db, req.session));
  app.post("/api/auth/setup", pub, async (req, reply) => {
    const { token, user } = await auth.setup(db, req.body, terminalOf(req), now());
    setSessionCookie(reply, token);
    return reply.status(201).send(user);
  });
  app.post("/api/auth/login", pub, async (req, reply) => {
    const { token, user } = await auth.login(db, req.body, terminalOf(req), now());
    setSessionCookie(reply, token);
    return user;
  });
  app.post("/api/auth/pin", pub, async (req, reply) => {
    const { token, user } = await auth.pinLogin(db, req.body, terminalOf(req), now());
    setSessionCookie(reply, token);
    return user;
  });
  app.post<{ Body: { ids?: unknown } }>("/api/auth/tiles", pub, async (req) =>
    auth.tiles(db, Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []),
  );
  app.post("/api/auth/logout", { config: { duringPasswordChange: true } }, async (req, reply) => {
    await auth.logout(db, req.session!, terminalOf(req));
    reply.clearCookie(SESSION_COOKIE, { path: "/api" });
    return { ok: true };
  });
  app.post("/api/auth/credentials", { config: { duringPasswordChange: true } }, async (req) =>
    auth.changeCredentials(db, req.session!, req.body, terminalOf(req)),
  );

  // ── Users (administration) ──
  app.get("/api/users", need("users.manage"), async () => auth.listUsers(db));
  app.post("/api/users", need("users.manage"), async (req, reply) => reply.status(201).send(await auth.createUser(db, actorOf(req), req.body)));
  app.patch<{ Params: { id: string } }>("/api/users/:id", need("users.manage"), async (req) =>
    auth.updateUser(db, actorOf(req), req.session!.user.id, req.params.id, req.body),
  );

  // ── Settings (clinic, doctors, holidays, leave) ──
  const manage = need("settings.manage");
  app.get("/api/settings/facility", manage, async () => settings.getFacility(db));
  app.put("/api/settings/facility", manage, async (req) => settings.updateFacility(db, actorOf(req), req.body));
  app.post("/api/settings/complete-setup", manage, async (req) => settings.completeSetup(db, actorOf(req)));
  app.get("/api/settings/practitioners", manage, async () => listPractitioners(db, { includeInactive: true }));
  app.post("/api/settings/practitioners", manage, async (req, reply) =>
    reply.status(201).send(await settings.createPractitioner(db, actorOf(req), req.body)),
  );
  app.put<{ Params: { id: string } }>("/api/settings/practitioners/:id", manage, async (req) =>
    settings.updatePractitioner(db, actorOf(req), req.params.id, req.body),
  );
  app.get("/api/settings/holidays", manage, async () => settings.listHolidays(db, localDate(now())));
  app.post("/api/settings/holidays", manage, async (req, reply) => reply.status(201).send(await settings.addHoliday(db, actorOf(req), req.body)));
  app.delete<{ Params: { date: string } }>("/api/settings/holidays/:date", manage, async (req) => {
    await settings.deleteHoliday(db, actorOf(req), dateParam(req.params.date));
    return { ok: true };
  });
  app.get("/api/settings/leaves", manage, async () => settings.listLeaves(db, localDate(now())));
  app.post("/api/settings/leaves", manage, async (req, reply) => reply.status(201).send(await settings.addLeave(db, actorOf(req), req.body)));
  app.delete<{ Params: { id: string } }>("/api/settings/leaves/:id", manage, async (req) => {
    await settings.deleteLeave(db, actorOf(req), req.params.id);
    return { ok: true };
  });

  // ── Backups ──
  app.get("/api/backups/status", manage, async () => backups.status());
  app.put("/api/backups/config", manage, async (req) => backups.configure(actorOf(req), req.body));
  app.post("/api/backups/run", manage, async (req) => backups.run("manual", actorOf(req)));
  app.get("/api/backups/runs", manage, async () => backups.runs());
  app.get<{ Querystring: { folder?: string } }>("/api/backups/files", manage, async (req) => backups.listFiles(req.query.folder || undefined));
  app.post("/api/backups/restore", manage, async (req, reply) => {
    const result = await backups.restore(actorOf(req), req.body);
    reply.clearCookie(SESSION_COOKIE, { path: "/api" }); // everyone signs in again, including this desk
    return result;
  });
  // Disaster recovery on a new or wiped PC: before anyone is set up, restore instead of starting blank.
  const onlyBeforeSetup = async () => {
    if (!(await auth.needsSetup(db))) throw new AppError(403, "already_set_up", "Ojas is already set up. Sign in as an administrator to restore.");
  };
  app.get<{ Querystring: { folder?: string } }>("/api/setup/backups", pub, async (req) => {
    await onlyBeforeSetup();
    return backups.listFiles(req.query.folder || undefined);
  });
  app.post("/api/setup/restore", pub, async (req) => {
    await onlyBeforeSetup();
    return backups.restore({ user: "(first-run restore)", terminal: terminalOf(req) }, req.body);
  });

  // ── Patients ──
  app.get<{ Querystring: { q?: string } }>("/api/patients/search", need("patients.read"), async (req) => searchPatients(db, req.query.q ?? ""));
  app.get<{ Params: { id: string } }>("/api/patients/:id", need("patients.read"), async (req) => getPatient(db, req.params.id));
  app.post<{ Querystring: { force?: string } }>("/api/patients", need("patients.write"), async (req, reply) => {
    const patient = await quickRegister(db, actorOf(req), req.body, req.query.force === "true");
    return reply.status(201).send(patient);
  });

  // ── Scheduling ──
  app.get("/api/practitioners", async () => listPractitioners(db));
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>("/api/practitioners/:id/slots", async (req) =>
    slotsFor(db, req.params.id, dateParam(req.query.date), now()),
  );

  // ── Front desk ──
  app.post("/api/front-desk/checkout", need("appointments.book", "billing.collect"), async (req, reply) => {
    const receipt = await checkout(db, actorOf(req), req.body, now(), { allowDiscount: can(req.session!.user.role, "billing.discount") });
    notifyQueue(localDate(new Date(receipt.slotStart)));
    return reply.status(201).send(receipt);
  });
  app.get<{ Params: { id: string } }>("/api/invoices/:id/receipt", need("billing.collect"), async (req) => getReceipt(db, req.params.id));

  // ── Queue ──
  app.get<{ Querystring: { date?: string; practitionerId?: string } }>("/api/queue", async (req) =>
    queueFor(db, dateParam(req.query.date), req.query.practitionerId || undefined),
  );
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>("/api/appointments/:id/status", need("queue.update"), async (req) => {
    const { visitDate } = await setStatus(db, actorOf(req), req.params.id, req.body?.status);
    notifyQueue(visitDate);
    return { ok: true };
  });

  // ── OPD consultation ──
  type ById = { Params: { id: string } };
  const afterSave = (r: consult.SaveResult, appointmentId: string) => {
    realtime.broadcast({ type: "consult.changed", appointmentId });
    if (r.queueChanged) notifyQueue(r.visitDate);
    return r.encounter;
  };
  app.get<{ Querystring: { kind?: string; q?: string } }>("/api/consult/suggestions", need("consult.write"), async (req) =>
    consult.suggestions(db, req.query.kind, req.query.q ?? ""),
  );
  app.get<ById>("/api/consult/:id", need("consult.read"), async (req) => consult.getConsult(db, idParam(req.params.id)));
  app.get<ById>("/api/consult/:id/history", need("consult.read"), async (req) => {
    const view = await consult.getConsult(db, idParam(req.params.id));
    return consult.patientHistory(db, view.patient.id, view.appointmentId);
  });
  app.get<ById>("/api/consult/:id/versions", need("consult.read"), async (req) => consult.versions(db, idParam(req.params.id)));
  app.put<ById>("/api/consult/:id/vitals", need("vitals.write"), async (req) =>
    afterSave(await consult.saveVitals(db, actorOf(req), idParam(req.params.id), req.body), req.params.id),
  );
  app.put<ById>("/api/consult/:id/notes", need("consult.write"), async (req) =>
    afterSave(await consult.saveNotes(db, actorOf(req), idParam(req.params.id), req.body), req.params.id),
  );
  app.post<ById>("/api/consult/:id/sign", need("consult.write"), async (req) =>
    afterSave(await consult.sign(db, actorOf(req), idParam(req.params.id)), req.params.id),
  );
  app.post<ById>("/api/consult/:id/reopen", need("consult.write"), async (req) =>
    afterSave(await consult.reopen(db, actorOf(req), idParam(req.params.id), req.body), req.params.id),
  );

  // ── Pharmacy ──
  const ph = (p: Permission) => need(p);
  const today = () => localDate(now());
  app.get<{ Querystring: { q?: string; all?: string; inStock?: string } }>("/api/pharmacy/items", async (req) => {
    const perms = req.session!.user.permissions;
    if (!perms.some((p) => p.startsWith("pharmacy."))) throw new AppError(403, "forbidden", "You don't have permission to do this. Ask an administrator.");
    return pharmacy.listItems(db, { q: req.query.q, includeInactive: req.query.all === "true", inStock: req.query.inStock === "true", today: today() });
  });
  app.post("/api/pharmacy/items", ph("pharmacy.stock"), async (req, reply) => reply.status(201).send(await pharmacy.createItem(db, actorOf(req), req.body)));
  app.put<ById>("/api/pharmacy/items/:id", ph("pharmacy.stock"), async (req) => pharmacy.updateItem(db, actorOf(req), idParam(req.params.id), req.body));
  app.get<ById>("/api/pharmacy/items/:id/batches", ph("pharmacy.sell"), async (req) => pharmacy.batchesFor(db, idParam(req.params.id), today()));
  app.get("/api/pharmacy/suppliers", ph("pharmacy.purchase"), async () => pharmacy.listSuppliers(db));
  app.post("/api/pharmacy/suppliers", ph("pharmacy.purchase"), async (req, reply) => reply.status(201).send(await pharmacy.saveSupplier(db, actorOf(req), null, req.body)));
  app.put<ById>("/api/pharmacy/suppliers/:id", ph("pharmacy.purchase"), async (req) => pharmacy.saveSupplier(db, actorOf(req), idParam(req.params.id), req.body));
  app.get("/api/pharmacy/purchases", ph("pharmacy.purchase"), async () => pharmacyTx.listPurchases(db));
  app.post("/api/pharmacy/purchases", ph("pharmacy.purchase"), async (req, reply) => reply.status(201).send(await pharmacyTx.receivePurchase(db, actorOf(req), req.body, now())));
  app.get("/api/pharmacy/stock/alerts", ph("pharmacy.stock"), async () => pharmacy.stockAlerts(db, today()));
  app.post("/api/pharmacy/stock/adjust", ph("pharmacy.stock"), async (req) => pharmacy.adjustStock(db, actorOf(req), req.body));
  app.get("/api/pharmacy/prescriptions", ph("pharmacy.sell"), async () => pharmacyTx.pendingPrescriptions(db, now()));
  app.post("/api/pharmacy/sales", ph("pharmacy.sell"), async (req, reply) =>
    reply.status(201).send(await pharmacyTx.sell(db, actorOf(req), req.body, now(), { allowDiscount: can(req.session!.user.role, "billing.discount") })),
  );
  app.get<{ Querystring: { date?: string } }>("/api/pharmacy/sales", ph("pharmacy.sell"), async (req) => pharmacyTx.listSales(db, dateParam(req.query.date ?? today())));
  app.get<ById>("/api/pharmacy/sales/:id", ph("pharmacy.sell"), async (req) => pharmacyTx.getBill(db, idParam(req.params.id)));
  app.get<{ Querystring: { from?: string; to?: string; schedule?: string } }>("/api/pharmacy/register", ph("pharmacy.reports"), async (req) => {
    const schedules = (req.query.schedule ?? "H1,X").split(",").map((x) => DrugSchedule.parse(x.trim()));
    return pharmacyTx.register(db, dateParam(req.query.from ?? today()), dateParam(req.query.to ?? req.query.from ?? today()), schedules);
  });

  // ── Laboratory ──
  const labChanged = <T extends { id: string } | { orderId: string }>(r: T, orderId?: string): T => {
    realtime.broadcast({ type: "lab.changed", orderId: orderId ?? ("orderId" in r ? r.orderId : r.id) });
    return r;
  };
  const orderOfTest = async (testId: string) =>
    (await db.query<{ order_id: string }>("select order_id from lab.order_test where id = $1", [testId])).rows[0]?.order_id;
  app.get<{ Querystring: { q?: string; all?: string } }>("/api/lab/tests", async (req) => {
    const perms = req.session!.user.permissions;
    if (!perms.some((p) => p.startsWith("lab."))) throw new AppError(403, "forbidden", "You don't have permission to do this. Ask an administrator.");
    return labCatalog.listTests(db, { q: req.query.q, includeInactive: req.query.all === "true" });
  });
  app.post("/api/lab/tests", need("lab.tests"), async (req, reply) => reply.status(201).send(await labCatalog.createTest(db, actorOf(req), req.body)));
  app.put<ById>("/api/lab/tests/:id", need("lab.tests"), async (req) => labCatalog.updateTest(db, actorOf(req), idParam(req.params.id), req.body));
  app.post("/api/lab/tests/starter", need("lab.tests"), async (req) => labCatalog.addStarterTests(db, actorOf(req)));
  app.get("/api/lab/requests", need("lab.order"), async () => lab.pendingRequests(db, now()));
  app.post("/api/lab/orders", need("lab.order"), async (req, reply) =>
    reply.status(201).send(labChanged(await lab.billOrder(db, actorOf(req), req.body, now(), { allowDiscount: can(req.session!.user.role, "billing.discount") }))),
  );
  app.get<{ Querystring: { date?: string } }>("/api/lab/orders", need("lab.read"), async (req) => lab.listOrders(db, dateParam(req.query.date ?? today()), now()));
  app.get<ById>("/api/lab/orders/:id", need("lab.read"), async (req) => lab.getOrder(db, idParam(req.params.id)));
  app.post<ById>("/api/lab/orders/:id/collect", need("lab.collect"), async (req) => labChanged(await lab.collect(db, actorOf(req), idParam(req.params.id), req.body, now())));
  app.post<ById>("/api/lab/samples/:id/reject", need("lab.collect"), async (req) => labChanged(await lab.rejectSample(db, actorOf(req), idParam(req.params.id), req.body, now())));
  app.put<ById>("/api/lab/results/:id", need("lab.result"), async (req) => {
    const r = await lab.saveResults(db, actorOf(req), idParam(req.params.id), req.body, now());
    return labChanged(r, await orderOfTest(r.id));
  });
  app.post<ById>("/api/lab/results/:id/verify", need("lab.verify"), async (req) => {
    const r = await lab.verify(db, actorOf(req), idParam(req.params.id), req.body, now());
    return labChanged(r, await orderOfTest(r.id));
  });
  app.post<ById>("/api/lab/results/:id/amend", need("lab.verify"), async (req) => {
    const r = await lab.amend(db, actorOf(req), idParam(req.params.id), req.body);
    return labChanged(r, await orderOfTest(r.id));
  });
  app.get<ById>("/api/lab/patients/:id/results", need("lab.read"), async (req) => lab.patientResults(db, idParam(req.params.id)));

  // ── Web UI for LAN browsers / token displays ──
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ code: "not_found", message: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
