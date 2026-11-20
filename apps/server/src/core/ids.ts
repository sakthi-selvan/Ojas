import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): time-ordered, so rows created on different sites/PCs can later be merged
 * (multi-branch / cloud sync) without key collisions, while staying index-friendly.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
