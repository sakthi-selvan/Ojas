/** Wards and beds (with their daily rates), the bed board, and the list of priced in-patient services. */
import { ServiceInput, WardInput, type Bed, type BedOccupant, type IpdService, type Ward } from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";

interface WardRow { id: string; name: string; kind: Ward["kind"]; bed_charge: number; nursing_charge: number; active: boolean }
interface BedRow { id: string; ward_id: string; label: string; active: boolean; needs_cleaning: boolean }
interface OccupantRow {
  bed_id: string; id: string; admission_no: string; p_name: string; uhid: string; sex: BedOccupant["sex"]; dob: string | null;
  admitted_at: string; doctor_name: string; summary_signed_at: string | null;
}

/** Every ward with its beds and who is in each; inactive wards and beds only when asked (setup screen). */
export async function listWards(q: Queryable, opts: { includeInactive?: boolean } = {}): Promise<Ward[]> {
  const all = !!opts.includeInactive;
  const wards = (await q.query<WardRow>("select * from ipd.ward where $1 or active order by name", [all])).rows;
  const beds = (await q.query<BedRow>("select * from ipd.bed where $1 or active order by ward_id, sort_no", [all])).rows;
  const occ = (await q.query<OccupantRow>(
    `select a.bed_id, a.id, a.admission_no, p.name as p_name, p.uhid, p.sex, p.dob, a.admitted_at, d.name as doctor_name, a.summary_signed_at
       from ipd.admission a join core.patient p on p.id = a.patient_id join core.practitioner d on d.id = a.practitioner_id
      where a.status = 'ADMITTED'`,
  )).rows;
  const byBed = new Map(occ.map((o) => [o.bed_id, o]));
  return wards.map((w) => ({
    id: w.id, name: w.name, kind: w.kind, bedCharge: w.bed_charge, nursingCharge: w.nursing_charge, active: w.active,
    beds: beds.filter((b) => b.ward_id === w.id).map((b): Bed => {
      const o = byBed.get(b.id);
      return {
        id: b.id, label: b.label, active: b.active,
        state: o ? "OCCUPIED" : b.needs_cleaning ? "CLEANING" : "FREE",
        occupant: o ? {
          admissionId: o.id, admissionNo: o.admission_no, patientName: o.p_name, uhid: o.uhid, sex: o.sex, dob: o.dob,
          admittedAt: o.admitted_at, doctorName: o.doctor_name, dischargeAdvised: !!o.summary_signed_at,
        } : null,
      };
    }),
  }));
}

async function getWard(q: Queryable, id: string): Promise<Ward> {
  const w = (await listWards(q, { includeInactive: true })).find((x) => x.id === id);
  if (!w) throw new AppError(404, "ward_not_found", "Ward not found");
  return w;
}

const duplicateName = (e: unknown) => {
  if (isUniqueViolation(e, "ward_name_key")) throw new AppError(409, "ward_exists", "There is already a ward with this name", { fields: { name: "Already used" } });
  throw e;
};

export async function createWard(db: Db, actor: Actor, raw: unknown): Promise<Ward> {
  const v = WardInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const id = uuidv7();
      await q.query(
        "insert into ipd.ward (id, name, kind, bed_charge, nursing_charge, active, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7)",
        [id, v.name, v.kind, v.bedCharge, v.nursingCharge, v.active, actor.user],
      );
      for (const [i, label] of v.beds.entries()) {
        await q.query("insert into ipd.bed (id, ward_id, label, sort_no, created_by, updated_by) values ($1,$2,$3,$4,$5,$5)", [uuidv7(), id, label, i + 1, actor.user]);
      }
      await audit(q, actor, "ipd.ward.create", "ward", id, { name: v.name, beds: v.beds.length, bedCharge: v.bedCharge, nursingCharge: v.nursingCharge });
      return getWard(q, id);
    });
  } catch (e) {
    return duplicateName(e);
  }
}

/**
 * Saves a ward. Beds are matched by name: new names are added, missing ones are taken out of use.
 * A bed with a patient in it can't be taken out of use, and neither can a ward.
 */
export async function updateWard(db: Db, actor: Actor, id: string, raw: unknown): Promise<Ward> {
  const v = WardInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const before = (await q.query<WardRow>("select * from ipd.ward where id = $1 for update", [id])).rows[0];
      if (!before) throw new AppError(404, "ward_not_found", "Ward not found");
      const beds = (await q.query<BedRow>("select * from ipd.bed where ward_id = $1", [id])).rows;
      const occupied = new Set((await q.query<{ bed_id: string }>(
        "select bed_id from ipd.admission where status = 'ADMITTED' and bed_id = any($1::uuid[])", [beds.map((b) => b.id)],
      )).rows.map((r) => r.bed_id));
      const wanted = new Map(v.beds.map((l, i) => [l.toUpperCase(), { label: l, sort: i + 1 }]));
      for (const b of beds) {
        const keep = wanted.get(b.label.toUpperCase());
        const active = !!keep && v.active;
        if (!active && occupied.has(b.id)) {
          throw new AppError(409, "bed_occupied", `Bed ${b.label} has a patient in it. Move or discharge them first.`, { fields: { beds: `${b.label} is occupied` } });
        }
        await q.query(
          "update ipd.bed set label = $2, sort_no = $3, active = $4, updated_by = $5, updated_at = now(), row_version = row_version + 1 where id = $1",
          [b.id, keep?.label ?? b.label, keep?.sort ?? 1000, !!keep, actor.user],
        );
        wanted.delete(b.label.toUpperCase());
      }
      for (const { label, sort } of wanted.values()) {
        await q.query("insert into ipd.bed (id, ward_id, label, sort_no, created_by, updated_by) values ($1,$2,$3,$4,$5,$5)", [uuidv7(), id, label, sort, actor.user]);
      }
      await q.query(
        "update ipd.ward set name = $2, kind = $3, bed_charge = $4, nursing_charge = $5, active = $6, updated_by = $7, updated_at = now(), row_version = row_version + 1 where id = $1",
        [id, v.name, v.kind, v.bedCharge, v.nursingCharge, v.active, actor.user],
      );
      await audit(q, actor, "ipd.ward.update", "ward", id, {
        name: v.name, beds: v.beds.length, active: v.active,
        ...(before.bed_charge !== v.bedCharge ? { bedCharge: [before.bed_charge, v.bedCharge] } : {}),
        ...(before.nursing_charge !== v.nursingCharge ? { nursingCharge: [before.nursing_charge, v.nursingCharge] } : {}),
      });
      return getWard(q, id);
    });
  } catch (e) {
    return duplicateName(e);
  }
}

/** Housekeeping has cleaned the bed after a discharge; it can take the next patient. */
export async function markBedReady(db: Db, actor: Actor, bedId: string): Promise<void> {
  await db.tx(async (q) => {
    const r = await q.query("update ipd.bed set needs_cleaning = false, updated_by = $2, updated_at = now() where id = $1 and needs_cleaning returning id", [bedId, actor.user]);
    if (!r.rows.length) throw new AppError(409, "bed_not_cleaning", "This bed isn't waiting to be cleaned");
    await audit(q, actor, "ipd.bed.ready", "bed", bedId, {});
  });
}

// ───────────────────────── Services ─────────────────────────

interface ServiceRow { id: string; name: string; category: IpdService["category"]; price: number; active: boolean }
const toService = (r: ServiceRow): IpdService => ({ id: r.id, name: r.name, category: r.category, price: r.price, active: r.active });

export async function listServices(q: Queryable, includeInactive = false): Promise<IpdService[]> {
  return (await q.query<ServiceRow>("select * from ipd.service where $1 or active order by category, name", [includeInactive])).rows.map(toService);
}

export async function saveService(db: Db, actor: Actor, id: string | null, raw: unknown): Promise<IpdService> {
  const v = ServiceInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const sid = id ?? uuidv7();
      if (id) {
        const r = await q.query(
          "update ipd.service set name = $2, category = $3, price = $4, active = $5, updated_by = $6, updated_at = now(), row_version = row_version + 1 where id = $1 returning id",
          [id, v.name, v.category, v.price, v.active, actor.user],
        );
        if (!r.rows.length) throw new AppError(404, "service_not_found", "Service not found");
      } else {
        await q.query(
          "insert into ipd.service (id, name, category, price, active, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6)",
          [sid, v.name, v.category, v.price, v.active, actor.user],
        );
      }
      await audit(q, actor, id ? "ipd.service.update" : "ipd.service.create", "service", sid, v);
      return toService((await q.query<ServiceRow>("select * from ipd.service where id = $1", [sid])).rows[0]!);
    });
  } catch (e) {
    if (isUniqueViolation(e, "service_name_key")) throw new AppError(409, "service_exists", "There is already a service with this name", { fields: { name: "Already used" } });
    throw e;
  }
}
