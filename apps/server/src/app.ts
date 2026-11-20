import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { can, type Permission } from "@ojas/shared";
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

export interface AppOptions {
  db: Db;
  webDir?: string;
  logger?: boolean;
  /** Injected clock for tests. */
  now?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    session: auth.SessionContext | null;
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

const terminalOf = (req: FastifyRequest) => String(req.headers["x-ojas-terminal"] ?? req.ip).slice(0, 64);

/** The signed-in user, as recorded in the audit trail. */
function actorOf(req: FastifyRequest): Actor {
  if (!req.session) throw new AppError(401, "not_signed_in", "Please sign in");
  return { user: req.session.user.username, terminal: terminalOf(req) };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false });
  const realtime = new Realtime();

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
      // TODO(tls): set `secure` once the LAN server uses HTTPS with the install-time certificate.
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
  app.get("/api/facility", pub, async () =>
    (await db.query("select name, address, phone from core.facility where id = 1")).rows[0],
  );

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

  // ── Web UI for LAN browsers / token displays ──
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ code: "not_found", message: "Not found" }) : reply.sendFile("index.html"),
    );
  }

  return app;
}
