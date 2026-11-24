import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { openDb, type Db } from "../src/db/index.js";
import { ensureFacility, seedDemo } from "../src/db/seed.js";
import { buildApp, SESSION_COOKIE } from "../src/app.js";

export const ADMIN = { displayName: "Asha Admin", username: "admin", password: "correct-horse-1" };

/** A signed-in (or anonymous) HTTP client against an in-process app, like one desk on the LAN. */
export class Client {
  constructor(private app: FastifyInstance, public cookie?: string, private terminal = "T-test") {}

  async req(opts: InjectOptions): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      ...opts,
      headers: { "x-ojas-terminal": this.terminal, ...(this.cookie ? { cookie: `${SESSION_COOKIE}=${this.cookie}` } : {}), ...(opts.headers ?? {}) },
    });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
    if (set) this.cookie = set.value || undefined;
    return res;
  }
  get = (url: string) => this.req({ method: "GET", url });
  post = (url: string, payload?: object) => this.req({ method: "POST", url, payload: payload ?? {} });
  patch = (url: string, payload: object) => this.req({ method: "PATCH", url, payload });
  put = (url: string, payload: object) => this.req({ method: "PUT", url, payload });
}

export async function makeApp(now: () => Date = () => new Date(), opts: { demo?: boolean } = { demo: true }): Promise<{ db: Db; app: FastifyInstance; anon: () => Client }> {
  const db = await openDb({});
  if (opts.demo) await seedDemo(db);
  else await ensureFacility(db);
  const app = await buildApp({ db, now });
  return { db, app, anon: () => new Client(app) };
}

/** First-run setup → a signed-in administrator. */
export async function setupAdmin(app: FastifyInstance): Promise<Client> {
  const c = new Client(app);
  const res = await c.post("/api/auth/setup", ADMIN);
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return c;
}

/** Admin creates a user, who signs in and replaces the temporary password. Returns their signed-in client. */
export async function userWithRole(app: FastifyInstance, admin: Client, role: string, username: string, pin?: string): Promise<{ client: Client; id: string }> {
  const created = await admin.post("/api/users", { displayName: `${role} ${username}`, username, role, password: "temp-pass-1" });
  if (created.statusCode !== 201) throw new Error(`create failed: ${created.body}`);
  const c = new Client(app);
  await c.post("/api/auth/login", { username, password: "temp-pass-1" });
  const changed = await c.post("/api/auth/credentials", { currentPassword: "temp-pass-1", newPassword: "real-pass-123", ...(pin ? { newPin: pin } : {}) });
  if (changed.statusCode !== 200) throw new Error(`credential change failed: ${changed.body}`);
  return { client: c, id: created.json().id };
}
