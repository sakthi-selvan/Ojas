import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  BackupConfigInput, RestoreInput,
  type BackupCopy, type BackupFile, type BackupReason, type BackupRun, type BackupStatus, type BackupWarning, type RestoreResult,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { EXTENSION, backupFileName, decryptBackup, deriveKey, encryptBackup, readHeader, type Key } from "./file.js";

const HOUR = 3_600_000;
/** After a failed scheduled run, wait this long before trying again (e.g. USB still unplugged). */
const RETRY_AFTER_FAILURE = 15 * 60_000;
/** Administrators are warned when the newest good backup is older than this. */
const STALE_AFTER = 24 * HOUR;

interface ConfigRow {
  keyring: Key[];
  primary_dir: string;
  secondary_dir: string;
  interval_hours: number;
  keep_count: number;
}

interface RunRow {
  id: string; started_at: string; finished_at: string | null; reason: BackupReason; ok: boolean;
  file_name: string | null; bytes: number | null; copies: BackupCopy[]; error: string | null; actor: string;
}

const toRun = (r: RunRow): BackupRun => ({
  id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, reason: r.reason, ok: r.ok, fileName: r.file_name,
  bytes: r.bytes, copies: r.copies, error: r.error, actor: r.actor,
});

/** Turns file-system errors into something a receptionist or admin can act on. */
function friendly(e: unknown, dir: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENODEV" || code === "ENXIO") return `${dir} isn't reachable. Is the backup drive connected?`;
  if (code === "ENOSPC") return `Not enough free space in ${dir}`;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `No permission to write to ${dir}`;
  if (e instanceof AppError) return e.message;
  return `${dir}: ${(e as Error)?.message ?? "unknown error"}`;
}

const ago = (ms: number) => {
  const h = Math.round(ms / HOUR);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
};

export class BackupService {
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private db: Db,
    private opts: { defaultDir: string; now?: () => Date; log?: (msg: string, err?: unknown) => void },
  ) {}

  private now = () => (this.opts.now ?? (() => new Date()))();
  get supported(): boolean {
    return !!this.db.snapshot && !!this.db.replaceFrom;
  }

  /** One backup or restore at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async config(q: Queryable = this.db): Promise<ConfigRow> {
    const { rows } = await q.query<ConfigRow>("select keyring, primary_dir, secondary_dir, interval_hours, keep_count from core.backup_config where id = 1");
    return rows[0]!;
  }
  private primaryDir = (c: ConfigRow) => c.primary_dir || this.opts.defaultDir;

  // ───────────────────────── Status ─────────────────────────

  async status(): Promise<BackupStatus> {
    const c = await this.config();
    const runs = await this.db.query<RunRow>(
      `(select * from core.backup_run order by started_at desc limit 1)
       union all (select * from core.backup_run where ok order by started_at desc limit 1)`,
    );
    const lastRun = runs.rows[0] ? toRun(runs.rows[0]) : null;
    const lastSuccess = runs.rows.find((r) => r.ok) ? toRun(runs.rows.find((r) => r.ok)!) : null;
    const configured = c.keyring.length > 0;
    const now = this.now().getTime();

    const warnings: BackupWarning[] = [];
    if (this.supported) {
      if (!configured) {
        warnings.push({ level: "danger", code: "not_configured", message: "Backups are not set up. If this PC's disk fails, all patient and billing records are lost." });
      } else if (lastRun && !lastRun.ok) {
        warnings.push({ level: "danger", code: "last_failed", message: `The last backup failed: ${lastRun.error ?? "unknown error"}` });
      } else if (!lastSuccess) {
        warnings.push({ level: "warn", code: "never_succeeded", message: "No backup has been made yet. The first one runs within a few minutes, or press Back up now." });
      } else if (now - Date.parse(lastSuccess.startedAt) > STALE_AFTER) {
        warnings.push({ level: "danger", code: "stale", message: `The last backup was ${ago(now - Date.parse(lastSuccess.startedAt))}.` });
      }
      const failedCopy = lastRun?.ok ? lastRun.copies.find((x) => !x.ok) : undefined;
      if (failedCopy) warnings.push({ level: "warn", code: "copy_failed", message: `Backup saved, but the second copy failed: ${failedCopy.error}` });
      if (configured && !c.secondary_dir) {
        warnings.push({ level: "info", code: "no_second_copy", message: "Backups are on this PC only. Add a second folder on a USB drive or another disk, so a disk failure can't take both." });
      }
    }

    return {
      supported: this.supported,
      configured,
      primaryDir: c.primary_dir,
      defaultDir: this.opts.defaultDir,
      secondaryDir: c.secondary_dir,
      intervalHours: c.interval_hours,
      keepCount: c.keep_count,
      running: this.busy,
      lastSuccess,
      lastRun,
      nextDueAt: configured && this.supported
        ? new Date(lastSuccess ? Date.parse(lastSuccess.startedAt) + c.interval_hours * HOUR : now).toISOString()
        : null,
      warnings,
    };
  }

  async runs(limit = 20): Promise<BackupRun[]> {
    const { rows } = await this.db.query<RunRow>("select * from core.backup_run order by started_at desc limit $1", [limit]);
    return rows.map(toRun);
  }

  // ───────────────────────── Settings ─────────────────────────

  async configure(actor: Actor, raw: unknown): Promise<BackupStatus> {
    if (!this.supported) throw new AppError(409, "not_supported", "This server uses an external PostgreSQL database. Back it up with PostgreSQL's own tools.");
    const v = BackupConfigInput.parse(raw);
    const c = await this.config();
    if (!c.keyring.length && !v.password) {
      throw new AppError(400, "validation_failed", "Set a backup password", { fields: { password: "Set a backup password" } });
    }
    if (v.primaryDir && v.primaryDir === v.secondaryDir) {
      throw new AppError(400, "validation_failed", "Use a different folder for the second copy", { fields: { secondaryDir: "Must differ from the main folder" } });
    }
    // Check both folders now, while someone is looking, rather than failing silently tonight.
    for (const [field, dir] of [["primaryDir", v.primaryDir || this.opts.defaultDir], ["secondaryDir", v.secondaryDir]] as const) {
      if (!dir) continue;
      try {
        await mkdir(dir, { recursive: true });
        const probe = join(dir, `.ojas-write-test-${process.pid}`);
        await writeFile(probe, "ok");
        await rm(probe, { force: true });
      } catch (e) {
        throw new AppError(400, "validation_failed", friendly(e, dir), { fields: { [field]: friendly(e, dir) } });
      }
    }
    const keyring = v.password ? [...c.keyring, await deriveKey(v.password)] : c.keyring;
    await this.db.tx(async (q) => {
      await q.query(
        `update core.backup_config set keyring = $1::jsonb, primary_dir = $2, secondary_dir = $3, interval_hours = $4, keep_count = $5,
                updated_at = now(), updated_by = $6, row_version = row_version + 1 where id = 1`,
        [JSON.stringify(keyring), v.primaryDir, v.secondaryDir, v.intervalHours, v.keepCount, actor.user],
      );
      // Never log the password or keys; just that it changed.
      await audit(q, actor, "backup.configure", "backup_config", "1", {
        primaryDir: v.primaryDir, secondaryDir: v.secondaryDir, intervalHours: v.intervalHours, keepCount: v.keepCount, passwordChanged: !!v.password,
      });
    });
    return this.status();
  }

  // ───────────────────────── Backup ─────────────────────────

  run(reason: BackupReason, actor: Actor): Promise<BackupRun> {
    return this.exclusive(() => this.backupNow(reason, actor));
  }

  /** Called by the scheduler: backs up when the interval has passed (or none exists yet). */
  async runIfDue(): Promise<BackupRun | null> {
    if (!this.supported || this.busy) return null;
    const s = await this.status();
    if (!s.configured || !s.nextDueAt) return null;
    const now = this.now().getTime();
    if (Date.parse(s.nextDueAt) > now) return null;
    if (s.lastRun && !s.lastRun.ok && now - Date.parse(s.lastRun.startedAt) < RETRY_AFTER_FAILURE) return null;
    return this.run("scheduled", { user: "system", terminal: "scheduler" });
  }

  start(): void {
    const tick = () =>
      void this.runIfDue().then(
        (r) => r && this.opts.log?.(`Backup ${r.ok ? "saved" : "FAILED"}: ${r.fileName ?? r.error}`),
        (e) => this.opts.log?.("Backup check failed", e),
      );
    this.timers.push(setTimeout(tick, 60_000), setInterval(tick, 5 * 60_000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async backupNow(reason: BackupReason, actor: Actor): Promise<BackupRun> {
    if (!this.supported) throw new AppError(409, "not_supported", "This server uses an external PostgreSQL database. Back it up with PostgreSQL's own tools.");
    const c = await this.config();
    const key = c.keyring[c.keyring.length - 1];
    if (!key) throw new AppError(409, "not_configured", "Set up backups first (Settings → Backups)");

    const startedAt = this.now();
    const fileName = backupFileName(startedAt, reason);
    const copies: BackupCopy[] = [];
    let bytes: number | null = null;
    let error: string | null = null;
    const primary = this.primaryDir(c);

    try {
      const meta = await this.db.query<{ name: string; schema: number; pg: number }>(
        `select (select name from core.facility where id = 1) as name,
                (select max(id) from public.schema_migrations)::int as schema,
                (current_setting('server_version_num')::int / 10000) as pg`,
      );
      const snapshot = await this.db.snapshot!();
      const file = encryptBackup(snapshot, key, {
        createdAt: startedAt.toISOString(), facilityName: meta.rows[0]!.name, reason,
        schemaVersion: meta.rows[0]!.schema, pgMajor: meta.rows[0]!.pg,
      });
      bytes = file.length;
      const fileHash = createHash("sha256").update(file).digest("hex");

      // Main copy: written to a temp name, read back and decrypted, then renamed into place.
      try {
        await this.writeVerified(primary, fileName, file, fileHash, key);
        copies.push({ dir: primary, ok: true });
      } catch (e) {
        throw new AppError(500, "backup_failed", friendly(e, primary));
      }
      if (c.secondary_dir) {
        try {
          await this.writeVerified(c.secondary_dir, fileName, file, fileHash, key);
          copies.push({ dir: c.secondary_dir, ok: true });
        } catch (e) {
          copies.push({ dir: c.secondary_dir, ok: false, error: friendly(e, c.secondary_dir) });
        }
      }
      for (const dir of copies.filter((x) => x.ok).map((x) => x.dir)) await this.rotate(dir, c.keep_count).catch(() => {});
    } catch (e) {
      error = e instanceof AppError ? e.message : `Backup failed: ${(e as Error).message}`;
      this.opts.log?.("Backup failed", e);
    }

    const run: RunRow = {
      id: uuidv7(), started_at: startedAt.toISOString(), finished_at: this.now().toISOString(), reason, ok: !error,
      file_name: error ? null : fileName, bytes: error ? null : bytes, copies, error, actor: actor.user,
    };
    await this.db.query(
      `insert into core.backup_run (id, started_at, finished_at, reason, ok, file_name, bytes, copies, error, actor)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [run.id, run.started_at, run.finished_at, run.reason, run.ok, run.file_name, run.bytes, JSON.stringify(run.copies), run.error, run.actor],
    );
    return toRun(run);
  }

  private async writeVerified(dir: string, fileName: string, file: Buffer, fileHash: string, key: Key): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${fileName}.partial`);
    await writeFile(tmp, file);
    const back = await readFile(tmp);
    if (createHash("sha256").update(back).digest("hex") !== fileHash) throw new Error("the file read back differently (disk error?)");
    decryptBackup(back, key); // proves the copy on disk is restorable
    await rename(tmp, join(dir, fileName));
  }

  /** Keep the newest `keep` backups in a folder; only touches files this app named. */
  private async rotate(dir: string, keep: number): Promise<void> {
    const names = (await readdir(dir)).filter((n) => /^ojas-\d{8}-\d{6}-[a-z-]+\.ojasbak$/.test(n)).sort().reverse();
    for (const n of names.slice(keep)) await rm(join(dir, n), { force: true });
  }

  // ───────────────────────── Restore ─────────────────────────

  /** Backups found in a folder, or in the configured folders. Reads only each file's header. */
  async listFiles(folder?: string): Promise<BackupFile[]> {
    const c = await this.config();
    if (folder !== undefined && !isAbsolute(folder)) {
      throw new AppError(400, "validation_failed", "Use a full folder path, like E:\\OjasBackups", { fields: { folder: "Use a full folder path" } });
    }
    const dirs = folder ? [resolve(folder)] : [this.primaryDir(c), c.secondary_dir].filter(Boolean);
    const salts = new Set(c.keyring.map((k) => k.salt));
    const seen = new Map<string, BackupFile>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(EXTENSION));
      } catch (e) {
        if (folder) throw new AppError(404, "folder_not_found", friendly(e, dir), { fields: { folder: friendly(e, dir) } });
        continue;
      }
      for (const n of names) {
        if (seen.has(n)) continue;
        const path = join(dir, n);
        try {
          const fh = await open(path, "r");
          const head = Buffer.alloc(64 * 1024 + 12);
          const { bytesRead } = await fh.read(head, 0, head.length, 0);
          const size = (await fh.stat()).size;
          await fh.close();
          // readHeader expects room for the tag; pad so a short read of a big file still parses.
          const { header } = readHeader(Buffer.concat([head.subarray(0, bytesRead), Buffer.alloc(16)]));
          seen.set(n, {
            path, fileName: n, createdAt: header.createdAt, facilityName: header.facilityName, reason: header.reason,
            bytes: size, needsPassword: !salts.has(header.kdf.salt),
          });
        } catch {
          // Not ours, or unreadable: leave it out of the list.
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Replaces the whole database with a backup. A safety backup of the current data is taken first
   * (when backups are set up). Everyone is signed out. Backup settings and history of this install
   * are kept, so restoring an old backup doesn't bring back old folders or an old password.
   */
  restore(actor: Actor, raw: unknown): Promise<RestoreResult> {
    return this.exclusive(async () => {
      if (!this.supported) throw new AppError(409, "not_supported", "Restore isn't available with an external PostgreSQL database");
      const v = RestoreInput.parse(raw);
      if (!v.path.toLowerCase().endsWith(EXTENSION)) throw new AppError(400, "not_a_backup", "Choose an .ojasbak backup file");
      let file: Buffer;
      try {
        if (!(await stat(v.path)).isFile()) throw Object.assign(new Error(), { code: "ENOENT" });
        file = await readFile(v.path);
      } catch (e) {
        throw new AppError(404, "file_not_found", friendly(e, v.path));
      }
      const { header } = readHeader(file);
      const c = await this.config();
      let key = c.keyring.find((k) => k.salt === header.kdf.salt);
      if (!key) {
        if (!v.password) {
          throw new AppError(422, "password_required", "Enter the backup password this file was made with", { fields: { password: "Enter the backup password" } });
        }
        key = await deriveKey(v.password, header.kdf.salt, header.kdf);
      }
      const { plain } = decryptBackup(file, key);

      const cur = (await this.db.query<{ schema: number; pg: number }>(
        "select (select max(id) from public.schema_migrations)::int as schema, (current_setting('server_version_num')::int / 10000) as pg",
      )).rows[0]!;
      if (header.schemaVersion > cur.schema) throw new AppError(422, "backup_too_new", "This backup is from a newer version of Ojas. Update Ojas on this PC first.");
      if (header.pgMajor !== cur.pg) throw new AppError(422, "backup_incompatible", `This backup's database format (PostgreSQL ${header.pgMajor}) doesn't match this version of Ojas`);

      let safetyBackup: string | null = null;
      if (c.keyring.length) {
        const safety = await this.backupNow("pre-restore", actor);
        if (!safety.ok) throw new AppError(500, "safety_backup_failed", `Restore stopped: couldn't save a safety backup first. ${safety.error}`);
        safetyBackup = join(this.primaryDir(c), safety.fileName!);
      }
      const runs = (await this.db.query<RunRow>("select * from core.backup_run")).rows;

      await this.db.replaceFrom!(plain);

      await this.db.tx(async (q) => {
        const restored = await this.config(q);
        const merged = [...c.keyring, ...restored.keyring, key!].filter((k, i, all) => all.findIndex((x) => x.salt === k.salt) === i);
        if (c.keyring.length) {
          // This install's settings win; the backup's keys are added so its own older files stay restorable.
          await q.query(
            `update core.backup_config set keyring = $1::jsonb, primary_dir = $2, secondary_dir = $3, interval_hours = $4, keep_count = $5 where id = 1`,
            [JSON.stringify(merged), c.primary_dir, c.secondary_dir, c.interval_hours, c.keep_count],
          );
        } else {
          await q.query("update core.backup_config set keyring = $1::jsonb where id = 1", [JSON.stringify(merged)]);
        }
        for (const r of runs) {
          await q.query(
            `insert into core.backup_run (id, started_at, finished_at, reason, ok, file_name, bytes, copies, error, actor)
             values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) on conflict (id) do nothing`,
            [r.id, r.started_at, r.finished_at, r.reason, r.ok, r.file_name, r.bytes, JSON.stringify(r.copies), r.error, r.actor],
          );
        }
        await q.query("delete from core.session");
        await audit(q, actor, "system.restore", "backup", header.createdAt, { file: v.path, backupCreatedAt: header.createdAt, safetyBackup });
      });
      return { restoredFrom: v.path, createdAt: header.createdAt, safetyBackup };
    });
  }
}
