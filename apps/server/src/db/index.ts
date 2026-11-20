/**
 * Database adapter. The rest of the server only sees `Db` / `Queryable` and writes plain PostgreSQL.
 *
 *  - Standalone / dev:  PGlite (PostgreSQL compiled to WASM, stored in a local folder). No install.
 *  - Hospital LAN:      real PostgreSQL via `OJAS_DB_URL=postgres://...` (replication, pg_dump, many clients).
 *
 * Both engines run the same SQL and the same migrations, so a clinic that grows into a hospital
 * moves its data with a plain pg_dump/restore.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { existsSync, renameSync, rmSync } from "node:fs";
import { migrate } from "./migrations.js";

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script with no parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Run `fn` inside one transaction. Throwing rolls everything back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly engine: "pglite" | "postgres";
  /**
   * Embedded engine only: a consistent gzip'd tarball of the whole database folder (for backups).
   * The external PostgreSQL engine is backed up with the server's own tools (pg_dump, replication).
   */
  snapshot?(): Promise<Uint8Array>;
  /**
   * Embedded engine only: replace the live database with a snapshot. New queries wait, queries in
   * flight finish first, then the swap happens and migrations bring the snapshot up to date.
   * The previous folder is kept beside it as `<dataDir>.replaced-<time>` until the swap succeeds.
   */
  replaceFrom?(snapshot: Uint8Array): Promise<void>;
}

// Normalise types so both engines return identical JS values:
//   int8 → number (money in paise fits safely), date → "YYYY-MM-DD", timestamptz → ISO string.
const INT8 = 20;
const DATE = 1082;
const TIMESTAMPTZ = 1184;
const parseTimestamptz = (v: string) => new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString();

export async function openDb(opts: { url?: string; dataDir?: string }): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url) : await openPglite(opts.dataDir);
  await migrate(db);
  return db;
}

async function openPglite(dataDir?: string): Promise<Db> {
  const create = (loadDataDir?: Blob) =>
    PGlite.create({
      // undefined = in-memory (tests)
      dataDir,
      loadDataDir,
      parsers: { [INT8]: Number, [DATE]: (v: string) => v, [TIMESTAMPTZ]: parseTimestamptz },
    });
  let lite = await create();

  // A gate so a restore can swap the database safely: callers wait while it is closed, and the
  // swap waits until no call is still running.
  let gate: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let idle: (() => void) | undefined;
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    await gate;
    inFlight++;
    try {
      return await fn();
    } finally {
      if (--inFlight === 0) idle?.();
    }
  };
  const wrap = (q: { query: PGlite["query"]; exec: PGlite["exec"] }): Queryable => ({
    query: async (sql, params) => ({ rows: (await q.query(sql, params)).rows as never[] }),
    exec: async (sql) => void (await q.exec(sql)),
  });

  const db: Db = {
    engine: "pglite",
    query: (sql, params) => run(() => wrap(lite).query(sql, params)),
    exec: (sql) => run(() => wrap(lite).exec(sql)),
    tx: (fn) => run(() => lite.transaction((t) => fn(wrap(t)))),
    close: () => lite.close(),
    snapshot: () => run(async () => new Uint8Array(await (await lite.dumpDataDir("gzip")).arrayBuffer())),
    replaceFrom: async (snapshot) => {
      let open!: () => void;
      const previous = gate;
      gate = new Promise((r) => (open = r));
      try {
        await previous;
        if (inFlight > 0) await new Promise<void>((r) => (idle = r));
        idle = undefined;
        await lite.close();
        const aside = dataDir && existsSync(dataDir) ? `${dataDir}.replaced-${Date.now()}` : undefined;
        if (aside) renameSync(dataDir!, aside);
        try {
          lite = await create(new Blob([snapshot as BlobPart]));
          await migrate(wrapDb(lite));
        } catch (e) {
          // The snapshot didn't open: put the previous database back exactly as it was.
          await lite.close().catch(() => {});
          if (aside) {
            if (existsSync(dataDir!)) rmSync(dataDir!, { recursive: true, force: true });
            renameSync(aside, dataDir!);
          }
          lite = await create();
          throw e;
        }
      } finally {
        open();
      }
    },
  };
  return db;
}

/** A bare Db over one PGlite instance, for running migrations during a swap (bypasses the gate). */
function wrapDb(lite: PGlite): Db {
  const q = {
    query: async (sql: string, params?: unknown[]) => ({ rows: (await lite.query(sql, params)).rows as never[] }),
    exec: async (sql: string) => void (await lite.exec(sql)),
  };
  return {
    engine: "pglite",
    ...q,
    tx: (fn) => lite.transaction((t) => fn({
      query: async (sql, params) => ({ rows: (await t.query(sql, params)).rows as never[] }),
      exec: async (sql) => void (await t.exec(sql)),
    })),
    close: () => lite.close(),
  };
}

async function openPostgres(url: string): Promise<Db> {
  pg.types.setTypeParser(INT8, Number);
  pg.types.setTypeParser(DATE, (v) => v);
  pg.types.setTypeParser(TIMESTAMPTZ, parseTimestamptz);
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  await pool.query("select 1");
  return {
    engine: "postgres",
    query: async (sql, params) => ({ rows: (await pool.query(sql, params as unknown[])).rows }),
    exec: async (sql) => void (await pool.query(sql)),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({
          query: async (sql, params) => ({ rows: (await client.query(sql, params as unknown[])).rows }),
          exec: async (sql) => void (await client.query(sql)),
        });
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
