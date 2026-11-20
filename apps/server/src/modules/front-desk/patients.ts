import { QuickRegisterInput, type Patient, type PatientSearchResult } from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { localDate } from "../../core/clock.js";
import { nextUhid } from "../../core/numbering.js";

const COLUMNS = `p.id, p.uhid, p.name, p.sex, p.phone, p.dob, p.dob_estimated, p.created_at`;

interface PatientRow {
  id: string; uhid: string; name: string; sex: Patient["sex"]; phone: string; dob: string | null; dob_estimated: boolean; created_at: string;
}

const toPatient = (r: PatientRow): Patient => ({
  id: r.id, uhid: r.uhid, name: r.name, sex: r.sex, phone: r.phone, dob: r.dob, dobEstimated: r.dob_estimated, createdAt: r.created_at,
});

/** Normalise a name for search: lower-case, single spaces. */
const searchKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
/** Title-case for display, which receptionists usually skip: "ravi KUMAR" → "Ravi Kumar". */
const displayName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

/**
 * One search box for everything. The receptionist types whatever the patient says:
 *  - digits (≥3)     → phone prefix, or phone/UHID ending (e.g. last 4 digits)
 *  - "OJ-12" / UHID  → UHID match
 *  - text            → name prefix on any word
 * Results rank exact phone/UHID first, then most recent visit, so the returning patient is the top hit.
 */
export async function searchPatients(db: Queryable, raw: string, limit = 8): Promise<PatientSearchResult[]> {
  const q = raw.trim();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, "");
  const isNumeric = /^[\d\s+-]+$/.test(q) && digits.length >= 3;
  const phone = digits.replace(/^(91|0)(?=\d{10}$)/, "");
  const name = searchKey(q);

  const { rows } = await db.query<PatientRow & { last_visit_at: string | null; rank: number }>(
    `select ${COLUMNS},
            (select max(a.slot_start) from core.appointment a where a.patient_id = p.id and a.status <> 'CANCELLED') as last_visit_at,
            case when p.phone = $1::text or lower(p.uhid) = lower($2::text) then 0
                 when p.phone like $1::text || '%' then 1
                 else 2 end as rank
       from core.patient p
      where p.deleted_at is null
        and ( ($3::boolean and (p.phone like $1::text || '%' or p.phone like '%' || $1::text))
           or lower(p.uhid) = lower($2::text)
           or lower(p.uhid) like '%' || lower($2::text)
           or (not $3::boolean and (p.name_search like $4::text || '%' or p.name_search like '% ' || $4::text || '%')) )
      order by rank, last_visit_at desc nulls last, p.created_at desc
      limit $5::int`,
    [isNumeric ? phone : "~", q, isNumeric, name, limit],
  );
  return rows.map((r) => ({ ...toPatient(r), lastVisitAt: r.last_visit_at }));
}

export async function getPatient(db: Queryable, id: string): Promise<Patient> {
  const { rows } = await db.query<PatientRow>(`select ${COLUMNS} from core.patient p where p.id = $1::uuid and p.deleted_at is null`, [id]);
  if (!rows[0]) throw new AppError(404, "patient_not_found", "Patient not found");
  return toPatient(rows[0]);
}

/**
 * Quick registration (4 fields). Guards against the #1 data-quality problem in hospitals:
 * duplicate patient records. The same phone + same name returns 409 with the existing record, and
 * the UI offers "Use existing" in one keystroke. `force` registers anyway (e.g. twins sharing a phone).
 */
export async function quickRegister(db: Db, actor: Actor, input: unknown, force = false): Promise<Patient> {
  const v = QuickRegisterInput.parse(input);
  const name = displayName(v.name);
  const key = searchKey(v.name);

  let dob = v.dob ?? null;
  let estimated = false;
  if (!dob && v.ageYears !== undefined) {
    const now = new Date();
    dob = localDate(new Date(now.getFullYear() - v.ageYears, now.getMonth(), now.getDate()));
    estimated = true;
  }

  return db.tx(async (q) => {
    if (!force) {
      const dup = await q.query<PatientRow>(
        `select ${COLUMNS} from core.patient p where p.deleted_at is null and p.phone = $1 and p.name_search = $2 limit 1`,
        [v.phone, key],
      );
      if (dup.rows[0]) {
        throw new AppError(409, "possible_duplicate", `${name} is already registered with this phone number`, { existing: toPatient(dup.rows[0]) });
      }
    }
    const facility = await q.query<{ uhid_prefix: string }>("select uhid_prefix from core.facility where id = 1");
    const id = uuidv7();
    const uhid = await nextUhid(q, facility.rows[0]?.uhid_prefix ?? "OJ-");
    await q.query(
      `insert into core.patient (id, uhid, name, name_search, sex, phone, dob, dob_estimated, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, uhid, name, key, v.sex, v.phone, dob, estimated, actor.user],
    );
    await audit(q, actor, "patient.register", "patient", id, { uhid, name, phone: v.phone });
    return getPatient(q, id);
  });
}
