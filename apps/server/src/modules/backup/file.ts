/**
 * The .ojasbak file format:
 *
 *   "OJASBAK1" | header length (uint32 BE) | header JSON (UTF-8) | AES-256-GCM ciphertext | 16-byte tag
 *
 * The header is not secret (date, clinic name, versions, KDF salt), so a folder of backups can be
 * listed without the password. It is authenticated as GCM additional data, so it can't be altered
 * either. The ciphertext is the database snapshot (a gzip'd tarball).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import type { BackupReason } from "@ojas/shared";
import { AppError } from "../../core/errors.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const MAGIC = Buffer.from("OJASBAK1");
export const EXTENSION = ".ojasbak";

/** scrypt cost: ~100 ms on a clinic PC. Stored in each file so it can be raised later. */
export const KDF = { N: 2 ** 15, r: 8, p: 1 } as const;

export interface Key {
  salt: string; // base64
  key: string; // base64, 32 bytes
}

export interface BackupHeader {
  v: 1;
  createdAt: string;
  facilityName: string;
  reason: BackupReason;
  /** Highest migration applied in the snapshot. A newer server can restore it; an older one can't. */
  schemaVersion: number;
  /** PostgreSQL major version of the embedded engine. Data folders only open on the same major. */
  pgMajor: number;
  kdf: { alg: "scrypt"; salt: string; N: number; r: number; p: number };
  iv: string;
  /** SHA-256 of the plaintext snapshot, checked after decryption. */
  sha256: string;
  plainBytes: number;
}

export async function deriveKey(
  password: string,
  salt = randomBytes(16).toString("base64"),
  params: { N: number; r: number; p: number } = KDF,
): Promise<Key> {
  const key = await scrypt(password, Buffer.from(salt, "base64"), 32, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 });
  return { salt, key: key.toString("base64") };
}

export function encryptBackup(plain: Uint8Array, key: Key, meta: Omit<BackupHeader, "v" | "kdf" | "iv" | "sha256" | "plainBytes">): Buffer {
  const iv = randomBytes(12);
  const header: BackupHeader = {
    v: 1,
    ...meta,
    kdf: { alg: "scrypt", salt: key.salt, ...KDF },
    iv: iv.toString("base64"),
    sha256: createHash("sha256").update(plain).digest("hex"),
    plainBytes: plain.byteLength,
  };
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBuf.length);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key, "base64"), iv);
  cipher.setAAD(headerBuf);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, len, headerBuf, body, cipher.getAuthTag()]);
}

/** Reads only the header. Throws a readable error for anything that isn't an Ojas backup. */
export function readHeader(file: Buffer): { header: BackupHeader; headerBuf: Buffer; bodyStart: number } {
  if (file.length < 12 + 16 || !file.subarray(0, 8).equals(MAGIC)) {
    throw new AppError(422, "not_a_backup", "This isn't an Ojas backup file");
  }
  const len = file.readUInt32BE(8);
  if (len > 64 * 1024 || 12 + len + 16 > file.length) throw new AppError(422, "damaged_backup", "The backup file is damaged");
  const headerBuf = file.subarray(12, 12 + len);
  try {
    const header = JSON.parse(headerBuf.toString("utf8")) as BackupHeader;
    if (header.v !== 1) throw new Error("version");
    return { header, headerBuf, bodyStart: 12 + len };
  } catch {
    throw new AppError(422, "damaged_backup", "The backup file is damaged or from a newer version of Ojas");
  }
}

/** Decrypts and checks integrity. A wrong key and a damaged file look the same to GCM, by design. */
export function decryptBackup(file: Buffer, key: Key): { header: BackupHeader; plain: Buffer } {
  const { header, headerBuf, bodyStart } = readHeader(file);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.key, "base64"), Buffer.from(header.iv, "base64"));
    decipher.setAAD(headerBuf);
    decipher.setAuthTag(file.subarray(file.length - 16));
    const plain = Buffer.concat([decipher.update(file.subarray(bodyStart, file.length - 16)), decipher.final()]);
    if (createHash("sha256").update(plain).digest("hex") !== header.sha256) throw new Error("hash");
    return { header, plain };
  } catch {
    throw new AppError(422, "wrong_password", "Wrong backup password, or the file is damaged", { fields: { password: "Wrong password, or the file is damaged" } });
  }
}

/** ojas-20261120-1430-scheduled.ojasbak (local time, sorts by date). */
export function backupFileName(at: Date, reason: BackupReason): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `ojas-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}-${reason}${EXTENSION}`;
}
