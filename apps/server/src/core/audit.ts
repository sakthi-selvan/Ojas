import { createHash } from "node:crypto";
import type { Queryable } from "../db/index.js";

export interface Actor {
  user: string;
  terminal: string;
}

/**
 * Append one hash-chained audit event inside the caller's transaction.
 * hash = sha256(prev_hash | at | actor | terminal | action | entity | entity_id | data)
 * `verifyAuditChain` recomputes the chain, so any edited or deleted row is detected.
 */
export async function audit(
  q: Queryable,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  // Serialise writers to the chain (a no-op cost on PGlite, correct on multi-client Postgres).
  await q.query("select pg_advisory_xact_lock(7001)");
  const prev = await q.query<{ hash: string }>("select hash from core.audit_event order by seq desc limit 1");
  const prevHash = prev.rows[0]?.hash ?? "GENESIS";
  const at = new Date().toISOString();
  const json = canonicalJson(data);
  const hash = digest(prevHash, at, actor.user, actor.terminal, action, entity, entityId, json);
  await q.query(
    `insert into core.audit_event (at, actor, terminal, action, entity, entity_id, data, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [at, actor.user, actor.terminal, action, entity, entityId, json, prevHash, hash],
  );
}

/** JSON with recursively sorted keys: jsonb reorders keys, so hashing must not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function verifyAuditChain(q: Queryable): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const { rows } = await q.query<{
    seq: number; at: string; actor: string; terminal: string; action: string; entity: string; entity_id: string; data_text: string; prev_hash: string; hash: string;
  }>(`select seq, at, actor, terminal, action, entity, entity_id, data::text as data_text, prev_hash, hash from core.audit_event order by seq`);
  let prev = "GENESIS";
  for (const r of rows) {
    const json = canonicalJson(JSON.parse(r.data_text));
    if (r.prev_hash !== prev || digest(prev, r.at, r.actor, r.terminal, r.action, r.entity, r.entity_id, json) !== r.hash) {
      return { ok: false, checked: rows.length, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
