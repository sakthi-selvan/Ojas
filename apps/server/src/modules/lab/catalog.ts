/** The laboratory's test catalogue: what it does, at what price, and how each result is read. */
import { TestInput, type LabTest, type Parameter } from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { STARTER_TESTS } from "./starter.js";

export const nameKey = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface TestRow {
  id: string; code: string; name: string; section: LabTest["section"]; sample_type: LabTest["sampleType"]; price: number; tat_hours: number;
  method: string; aliases: string[]; notes: string; parameters: Parameter[]; active: boolean;
}

const toTest = (r: TestRow): LabTest => ({
  id: r.id, code: r.code, name: r.name, section: r.section, sampleType: r.sample_type, price: r.price, tatHours: r.tat_hours,
  method: r.method, aliases: r.aliases, notes: r.notes, parameters: r.parameters, active: r.active,
});

export async function listTests(q: Queryable, opts: { q?: string; includeInactive?: boolean; limit?: number } = {}): Promise<LabTest[]> {
  const term = likeEscape(nameKey(opts.q ?? "")).slice(0, 60);
  const { rows } = await q.query<TestRow>(
    `select * from lab.test t
      where ($1 = '' or lower(t.code) like $1 || '%' or t.name_search like $1 || '%' or t.name_search like '% ' || $1 || '%'
             or exists (select 1 from unnest(t.aliases) a where lower(a) like $1 || '%'))
        and ($2 or t.active)
      order by t.section, t.name_search
      limit $3`,
    [term, !!opts.includeInactive, opts.limit ?? 300],
  );
  return rows.map(toTest);
}

export async function getTest(q: Queryable, id: string): Promise<LabTest> {
  const r = (await q.query<TestRow>("select * from lab.test where id = $1", [id])).rows[0];
  if (!r) throw new AppError(404, "test_not_found", "Test not found");
  return toTest(r);
}

const duplicate = (e: unknown, code: string) =>
  isUniqueViolation(e, "test_code_key") ? new AppError(409, "test_exists", `Code ${code} is already used by another test`, { fields: { code: "Already used" } }) : e;

async function insert(q: Queryable, actor: Actor, v: ReturnType<typeof TestInput.parse>): Promise<string> {
  const id = uuidv7();
  await q.query(
    `insert into lab.test (id, code, name, name_search, section, sample_type, price, tat_hours, method, aliases, notes, parameters, active, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$14)`,
    [id, v.code, v.name, nameKey(v.name), v.section, v.sampleType, v.price, v.tatHours, v.method, v.aliases, v.notes, JSON.stringify(v.parameters), v.active, actor.user],
  );
  return id;
}

export async function createTest(db: Db, actor: Actor, raw: unknown): Promise<LabTest> {
  const v = TestInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const id = await insert(q, actor, v);
      await audit(q, actor, "lab.test.create", "lab_test", id, { code: v.code, name: v.name, price: v.price });
      return getTest(q, id);
    });
  } catch (e) {
    throw duplicate(e, v.code);
  }
}

/** Changes apply to tests billed from now on; orders already billed keep the definition they were billed with. */
export async function updateTest(db: Db, actor: Actor, id: string, raw: unknown): Promise<LabTest> {
  const v = TestInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const before = await getTest(q, id);
      await q.query(
        `update lab.test set code=$2, name=$3, name_search=$4, section=$5, sample_type=$6, price=$7, tat_hours=$8, method=$9, aliases=$10, notes=$11,
                parameters=$12::jsonb, active=$13, updated_at=now(), updated_by=$14, row_version=row_version+1 where id=$1`,
        [id, v.code, v.name, nameKey(v.name), v.section, v.sampleType, v.price, v.tatHours, v.method, v.aliases, v.notes, JSON.stringify(v.parameters), v.active, actor.user],
      );
      await audit(q, actor, "lab.test.update", "lab_test", id, {
        code: v.code, price: before.price === v.price ? undefined : { from: before.price, to: v.price },
        parameters: JSON.stringify(before.parameters) === JSON.stringify(v.parameters) ? undefined : "changed", active: v.active,
      });
      return getTest(q, id);
    });
  } catch (e) {
    throw duplicate(e, v.code);
  }
}

/**
 * For labs that loaded the starter tests before children's ranges existed: adds the starter's
 * children's ranges to each matching parameter (same test code and parameter) that has no age
 * ranges of its own yet. Ranges the lab has written are never touched.
 */
export async function addChildRanges(db: Db, actor: Actor): Promise<{ tests: number; parameters: number }> {
  return db.tx(async (q) => {
    const rows = (await q.query<{ id: string; code: string; parameters: Parameter[] }>("select id, code, parameters from lab.test for update")).rows;
    let tests = 0, parameters = 0;
    for (const row of rows) {
      const starter = STARTER_TESTS.find((t) => t.code === row.code);
      if (!starter) continue;
      const kids = new Map(TestInput.parse(starter).parameters.map((p) => [p.id, p.ranges.filter((x) => x.ageFrom !== null || x.ageTo !== null)]));
      let changed = 0;
      const next = row.parameters.map((p) => {
        const add = kids.get(p.id) ?? [];
        if (p.kind !== "NUMERIC" || !add.length || p.ranges.some((x) => x.ageFrom !== null || x.ageTo !== null)) return p;
        if (p.ranges.length + add.length > 24) return p;
        changed++;
        return { ...p, ranges: [...p.ranges, ...add] };
      });
      if (!changed) continue;
      await q.query("update lab.test set parameters = $2::jsonb, updated_at = now(), updated_by = $3, row_version = row_version + 1 where id = $1", [row.id, JSON.stringify(next), actor.user]);
      tests++;
      parameters += changed;
    }
    await audit(q, actor, "lab.test.child_ranges", "lab_test", "starter", { tests, parameters });
    return { tests, parameters };
  });
}

/** Adds the starter catalogue, skipping any code the lab already has. Returns how many were added. */
export async function addStarterTests(db: Db, actor: Actor): Promise<{ added: number; skipped: number }> {
  return db.tx(async (q) => {
    const have = new Set((await q.query<{ code: string }>("select code from lab.test")).rows.map((r) => r.code));
    let added = 0;
    for (const t of STARTER_TESTS) {
      const v = TestInput.parse(t);
      if (have.has(v.code)) continue;
      await insert(q, actor, v);
      added++;
    }
    await audit(q, actor, "lab.test.starter", "lab_test", "starter", { added });
    return { added, skipped: STARTER_TESTS.length - added };
  });
}

/** The catalogue test a doctor's free-text order most likely means ("CBC", "Fasting sugar", "Thyroid profile (T3, T4, TSH)"). */
export async function matchTest(q: Queryable, text: string): Promise<LabTest | null> {
  const key = nameKey(text);
  if (key.length < 2) return null;
  const all = await listTests(q);
  const exact = (t: LabTest) => [t.code, t.name, ...t.aliases].map(nameKey);
  // 1. The whole text is a code, name or alias. 2. A code or alias appears in brackets or as a word ("Complete blood count (CBC)").
  // When several fit, the longest name wins ("Thyroid profile" over "TSH").
  const exactHit = all.find((t) => exact(t).includes(key));
  if (exactHit) return exactHit;
  let best: { t: LabTest; len: number } | null = null;
  for (const t of all) {
    for (const k of exact(t)) {
      if (k.length >= 3 && ` ${key} `.includes(` ${k} `) && k.length > (best?.len ?? 0)) best = { t, len: k.length };
    }
  }
  return best?.t ?? null;
}
