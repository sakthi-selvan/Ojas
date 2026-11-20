/**
 * Backups: encrypted, verified copies of the whole database, written to one or two folders
 * (ideally the second is a USB drive or another disk) on a schedule, and restorable in one step.
 */
import { z } from "zod";

const Folder = z
  .string()
  .trim()
  .max(260)
  .refine((v) => v === "" || /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(v), "Use a full folder path, like E:\\OjasBackups");

export const BackupConfigInput = z.object({
  /** Required the first time. Needed to restore on another PC; changing it re-keys future backups only. */
  password: z.string().min(8, "At least 8 characters").max(128).optional(),
  /** Empty = the default folder next to the database. */
  primaryDir: Folder.default(""),
  /** A second copy, ideally on a USB drive or another disk. */
  secondaryDir: Folder.default(""),
  intervalHours: z.number().int().min(1).max(24).default(4),
  keepCount: z.number().int().min(3, "Keep at least 3").max(365).default(30),
});
export type BackupConfigInput = z.input<typeof BackupConfigInput>;

export type BackupReason = "scheduled" | "manual" | "pre-restore";

export interface BackupCopy {
  dir: string;
  ok: boolean;
  error?: string;
}

export interface BackupRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  reason: BackupReason;
  ok: boolean;
  fileName: string | null;
  bytes: number | null;
  copies: BackupCopy[];
  error: string | null;
  actor: string;
}

export interface BackupWarning {
  /** danger/warn are shown as a banner to administrators; info only on the Backups screen. */
  level: "danger" | "warn" | "info";
  code: "not_configured" | "never_succeeded" | "stale" | "last_failed" | "copy_failed" | "no_second_copy";
  message: string;
}

export interface BackupStatus {
  /** False when the database is an external PostgreSQL server (back it up with its own tools). */
  supported: boolean;
  configured: boolean;
  primaryDir: string;
  /** The folder used when primaryDir is empty. */
  defaultDir: string;
  secondaryDir: string;
  intervalHours: number;
  keepCount: number;
  running: boolean;
  lastSuccess: BackupRun | null;
  lastRun: BackupRun | null;
  nextDueAt: string | null;
  warnings: BackupWarning[];
}

/** A backup file found in a folder (read from its unencrypted header). */
export interface BackupFile {
  path: string;
  fileName: string;
  createdAt: string;
  facilityName: string;
  reason: BackupReason;
  bytes: number;
  /** False when this server already holds the key (same install); true on a new PC or after a password change. */
  needsPassword: boolean;
}

export const RestoreInput = z.object({
  path: z.string().min(3).max(400),
  password: z.string().max(128).optional(),
  confirm: z.literal("RESTORE", { error: 'Type RESTORE to confirm' }),
});
export type RestoreInput = z.input<typeof RestoreInput>;

export interface RestoreResult {
  restoredFrom: string;
  createdAt: string;
  /** The safety backup of the database as it was just before the restore. */
  safetyBackup: string | null;
}
