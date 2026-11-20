/**
 * Database adapter. The rest of the server only sees `Db` / `Queryable` and writes plain PostgreSQL.
 *
 *  - Standalone / dev:  PGlite (PostgreSQL compiled to WASM, stored in a local folder). No install.
 *  - Hospital LAN:      real PostgreSQL via `HS_DB_URL=postgres://...` (replication, pg_dump, many clients).
 *
 * Both engines run the same SQL and the same migrations, so a clinic that grows into a hospital
 * moves its data with a plain pg_dump/restore.
 */
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
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
  const lite = await PGlite.create({
    // undefined = in-memory (tests)
    dataDir,
    parsers: { [INT8]: Number, [DATE]: (v: string) => v, [TIMESTAMPTZ]: parseTimestamptz },
  });
  return {
    engine: "pglite",
    query: async (sql, params) => ({ rows: (await lite.query(sql, params)).rows as never[] }),
    exec: async (sql) => void (await lite.exec(sql)),
    tx: (fn) =>
      lite.transaction((t) =>
        fn({
          query: async (sql, params) => ({ rows: (await t.query(sql, params)).rows as never[] }),
          exec: async (sql) => void (await t.exec(sql)),
        }),
      ),
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
