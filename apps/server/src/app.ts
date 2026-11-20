import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
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

export interface AppOptions {
  db: Db;
  webDir?: string;
  logger?: boolean;
  /** Injected clock for tests. */
  now?: () => Date;
}

/**
 * TODO(auth): sign-in, roles and PIN-based user switching are the next milestone. Until then the
 * caller identifies itself with headers, and every action is still recorded in the audit trail.
 */
function actorOf(req: FastifyRequest): Actor {
  const h = req.headers;
  return {
    user: String(h["x-ojas-user"] ?? "reception").slice(0, 64),
    terminal: String(h["x-ojas-terminal"] ?? req.ip).slice(0, 64),
  };
}

const dateParam = (v: unknown): string => {
  if (v === undefined) return localDate();
  if (!isIsoDate(v)) throw new AppError(400, "invalid_date", "Date must be YYYY-MM-DD");
  return v;
};

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false });
  const realtime = new Realtime();

  // Only the Vite dev server and the Electron shell (file:// origin "null") call cross-origin.
  await app.register(cors, { origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/, "null"] });
  await app.register(websocket);

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

  // ── System ──
  app.get("/api/health", async () => ({ ok: true, engine: db.engine, serverTime: now().toISOString(), clients: realtime.size }));
  app.get("/api/events", { websocket: true }, (socket) => realtime.add(socket));
  app.get("/api/audit/verify", async () => verifyAuditChain(db));
  app.get("/api/facility", async () => (await db.query("select name, address, phone from core.facility where id = 1")).rows[0]);

  // ── Patients ──
  app.get<{ Querystring: { q?: string } }>("/api/patients/search", async (req) => searchPatients(db, req.query.q ?? ""));
  app.get<{ Params: { id: string } }>("/api/patients/:id", async (req) => getPatient(db, req.params.id));
  app.post<{ Querystring: { force?: string } }>("/api/patients", async (req, reply) => {
    const patient = await quickRegister(db, actorOf(req), req.body, req.query.force === "true");
    return reply.status(201).send(patient);
  });

  // ── Scheduling ──
  app.get("/api/practitioners", async () => listPractitioners(db));
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>("/api/practitioners/:id/slots", async (req) =>
    slotsFor(db, req.params.id, dateParam(req.query.date), now()),
  );

  // ── Front desk ──
  app.post("/api/front-desk/checkout", async (req, reply) => {
    const receipt = await checkout(db, actorOf(req), req.body, now());
    notifyQueue(localDate(new Date(receipt.slotStart)));
    return reply.status(201).send(receipt);
  });
  app.get<{ Params: { id: string } }>("/api/invoices/:id/receipt", async (req) => getReceipt(db, req.params.id));

  // ── Queue ──
  app.get<{ Querystring: { date?: string; practitionerId?: string } }>("/api/queue", async (req) =>
    queueFor(db, dateParam(req.query.date), req.query.practitionerId || undefined),
  );
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>("/api/appointments/:id/status", async (req) => {
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
