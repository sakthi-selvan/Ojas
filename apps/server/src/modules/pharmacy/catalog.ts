/**
 * Pharmacy catalogue and stock: medicines, suppliers, batches, adjustments and alerts.
 * Stock is only ever changed together with a stock_move row saying why.
 */
import {
  AdjustInput, ItemInput, NEAR_EXPIRY_DAYS, SupplierInput,
  type Batch, type GstRate, type Item, type StockAlerts, type Supplier,
} from "@ojas/shared";
import type { Db, Queryable } from "../../db/index.js";
import { audit, type Actor } from "../../core/audit.js";
import { AppError, isUniqueViolation } from "../../core/errors.js";
import { uuidv7 } from "../../core/ids.js";
import { localDate } from "../../core/clock.js";

export const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ───────────────────────── Medicines ─────────────────────────

interface ItemRow {
  id: string; name: string; generic: string; form: Item["form"]; strength: string; manufacturer: string; hsn: string; gst_rate: GstRate;
  schedule: Item["schedule"]; pack_size: number; reorder_level: number; active: boolean; on_hand: number; next_expiry: string | null; mrp: number | null;
}

const toItem = (r: ItemRow): Item => ({
  id: r.id, name: r.name, generic: r.generic, form: r.form, strength: r.strength, manufacturer: r.manufacturer, hsn: r.hsn, gstRate: r.gst_rate,
  schedule: r.schedule, packSize: r.pack_size, reorderLevel: r.reorder_level, active: r.active, onHand: r.on_hand, nextExpiry: r.next_expiry, mrpPerPack: r.mrp,
});

/** Items with their sellable (unexpired) stock, the next expiry and the price of the batch that sells next. */
const ITEM_SELECT = `
  select i.id, i.name, i.generic, i.form, i.strength, i.manufacturer, i.hsn, i.gst_rate, i.schedule, i.pack_size, i.reorder_level, i.active,
         coalesce(s.on_hand, 0) as on_hand, s.next_expiry,
         (select b.mrp_per_pack from pharmacy.batch b where b.item_id = i.id and b.on_hand > 0 and b.expiry >= $1::date
           order by b.expiry, b.created_at limit 1) as mrp
    from pharmacy.item i
    left join lateral (
      select sum(b.on_hand)::int as on_hand, min(b.expiry) as next_expiry
        from pharmacy.batch b where b.item_id = i.id and b.on_hand > 0 and b.expiry >= $1::date
    ) s on true`;

export async function listItems(q: Queryable, opts: { q?: string; includeInactive?: boolean; inStock?: boolean; limit?: number; today?: string } = {}): Promise<Item[]> {
  const term = likeEscape(nameKey(opts.q ?? "")).slice(0, 60);
  const { rows } = await q.query<ItemRow>(
    `${ITEM_SELECT}
      where ($2 = '' or i.name_search like $2 || '%' or i.name_search like '% ' || $2 || '%' or lower(i.generic) like '%' || $2 || '%')
        and ($3 or i.active) and (not $4 or coalesce(s.on_hand, 0) > 0)
      order by i.name_search, i.strength
      limit $5`,
    [opts.today ?? localDate(), term, !!opts.includeInactive, !!opts.inStock, opts.limit ?? 50],
  );
  return rows.map(toItem);
}

export async function getItem(q: Queryable, id: string, today = localDate()): Promise<Item> {
  const { rows } = await q.query<ItemRow>(`${ITEM_SELECT} where i.id = $2`, [today, id]);
  if (!rows[0]) throw new AppError(404, "item_not_found", "Medicine not found");
  return toItem(rows[0]);
}

const duplicateItem = (e: unknown) =>
  isUniqueViolation(e, "item_name_uq")
    ? new AppError(409, "item_exists", "This medicine (same name, strength and form) is already in the list", { fields: { name: "Already in the list" } })
    : e;

export async function createItem(db: Db, actor: Actor, raw: unknown): Promise<Item> {
  const v = ItemInput.parse(raw);
  const id = uuidv7();
  try {
    return await db.tx(async (q) => {
      await q.query(
        `insert into pharmacy.item (id, name, name_search, generic, form, strength, manufacturer, hsn, gst_rate, schedule, pack_size, reorder_level, active, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [id, v.name, nameKey(v.name), v.generic, v.form, v.strength, v.manufacturer, v.hsn, v.gstRate, v.schedule, v.packSize, v.reorderLevel, v.active, actor.user],
      );
      await audit(q, actor, "pharmacy.item.create", "item", id, { ...v });
      return getItem(q, id);
    });
  } catch (e) {
    throw duplicateItem(e);
  }
}

/** Pack size can't change once stock exists: batches were priced per pack of the old size. */
export async function updateItem(db: Db, actor: Actor, id: string, raw: unknown): Promise<Item> {
  const v = ItemInput.parse(raw);
  try {
    return await db.tx(async (q) => {
      const cur = await getItem(q, id);
      if (cur.packSize !== v.packSize) {
        const { rows } = await q.query<{ n: number }>("select count(*)::int as n from pharmacy.batch where item_id = $1", [id]);
        if (rows[0]!.n) {
          throw new AppError(422, "validation_failed", "Pack size can't change after stock has been received", { fields: { packSize: "Locked: stock was bought in packs of " + cur.packSize } });
        }
      }
      await q.query(
        `update pharmacy.item set name = $2, name_search = $3, generic = $4, form = $5, strength = $6, manufacturer = $7, hsn = $8, gst_rate = $9,
                schedule = $10, pack_size = $11, reorder_level = $12, active = $13, updated_at = now(), updated_by = $14, row_version = row_version + 1
          where id = $1`,
        [id, v.name, nameKey(v.name), v.generic, v.form, v.strength, v.manufacturer, v.hsn, v.gstRate, v.schedule, v.packSize, v.reorderLevel, v.active, actor.user],
      );
      await audit(q, actor, "pharmacy.item.update", "item", id, { ...v });
      return getItem(q, id);
    });
  } catch (e) {
    throw duplicateItem(e);
  }
}

// ───────────────────────── Suppliers ─────────────────────────

const SUPPLIER_COLS = `id, name, gstin, drug_licence as "drugLicence", phone, address`;

export async function listSuppliers(q: Queryable): Promise<Supplier[]> {
  return (await q.query<Supplier>(`select ${SUPPLIER_COLS} from pharmacy.supplier order by lower(name)`)).rows;
}

export async function saveSupplier(db: Db, actor: Actor, id: string | null, raw: unknown): Promise<Supplier> {
  const v = SupplierInput.parse(raw);
  const sid = id ?? uuidv7();
  try {
    return await db.tx(async (q) => {
      if (id) {
        const { rows } = await q.query<{ id: string }>(
          `update pharmacy.supplier set name = $2, gstin = $3, drug_licence = $4, phone = $5, address = $6, updated_at = now(), updated_by = $7, row_version = row_version + 1
            where id = $1 returning id`,
          [sid, v.name, v.gstin, v.drugLicence, v.phone, v.address, actor.user],
        );
        if (!rows[0]) throw new AppError(404, "supplier_not_found", "Supplier not found");
      } else {
        await q.query(
          `insert into pharmacy.supplier (id, name, gstin, drug_licence, phone, address, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [sid, v.name, v.gstin, v.drugLicence, v.phone, v.address, actor.user],
        );
      }
      await audit(q, actor, id ? "pharmacy.supplier.update" : "pharmacy.supplier.create", "supplier", sid, { ...v });
      return (await q.query<Supplier>(`select ${SUPPLIER_COLS} from pharmacy.supplier where id = $1`, [sid])).rows[0]!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, "supplier_exists", "A supplier with this name already exists", { fields: { name: "Already in the list" } });
    throw e;
  }
}

// ───────────────────────── Batches & stock ─────────────────────────

interface BatchRow {
  id: string; item_id: string; batch_no: string; expiry: string; mrp_per_pack: number; rate_per_pack: number; pack_size: number; gst_rate: GstRate; on_hand: number; item_name?: string;
}
const toBatch = (r: BatchRow, today: string): Batch => ({
  id: r.id, itemId: r.item_id, batchNo: r.batch_no, expiry: r.expiry, mrpPerPack: r.mrp_per_pack, ratePerPack: r.rate_per_pack,
  packSize: r.pack_size, gstRate: r.gst_rate, onHand: r.on_hand, expired: r.expiry < today,
});

/** Batches with stock, earliest expiry first (the order they sell in). Expired ones are listed so they can be removed. */
export async function batchesFor(q: Queryable, itemId: string, today = localDate()): Promise<Batch[]> {
  const { rows } = await q.query<BatchRow>(
    "select * from pharmacy.batch where item_id = $1 and on_hand > 0 order by expiry, created_at",
    [itemId],
  );
  return rows.map((r) => toBatch(r, today));
}

export async function adjustStock(db: Db, actor: Actor, raw: unknown): Promise<Batch> {
  const v = AdjustInput.parse(raw);
  return db.tx(async (q) => {
    const { rows } = await q.query<BatchRow>("select * from pharmacy.batch where id = $1 for update", [v.batchId]);
    const b = rows[0];
    if (!b) throw new AppError(404, "batch_not_found", "Batch not found");
    if (b.on_hand + v.qty < 0) {
      throw new AppError(422, "validation_failed", `Only ${b.on_hand} in stock in this batch`, { fields: { qty: `At most ${b.on_hand}` } });
    }
    await q.query("update pharmacy.batch set on_hand = on_hand + $2, updated_at = now(), updated_by = $3, row_version = row_version + 1 where id = $1", [b.id, v.qty, actor.user]);
    const reason = v.note ? `${v.reason}: ${v.note}` : v.reason;
    await q.query("insert into pharmacy.stock_move (id, batch_id, qty, kind, reason, actor) values ($1,$2,$3,'ADJUST',$4,$5)", [uuidv7(), b.id, v.qty, reason, actor.user]);
    await audit(q, actor, "pharmacy.stock.adjust", "batch", b.id, { qty: v.qty, reason: v.reason, note: v.note, before: b.on_hand });
    const after = (await q.query<BatchRow>("select * from pharmacy.batch where id = $1", [b.id])).rows[0]!;
    return toBatch(after, localDate());
  });
}

/** What needs the pharmacist's attention: expired stock still on the shelf, stock expiring soon, and low stock. */
export async function stockAlerts(q: Queryable, today = localDate()): Promise<StockAlerts> {
  const soon = new Date(`${today}T12:00:00`);
  soon.setDate(soon.getDate() + NEAR_EXPIRY_DAYS);
  const { rows } = await q.query<BatchRow>(
    `select b.*, i.name || case when i.strength <> '' then ' ' || i.strength else '' end as item_name
       from pharmacy.batch b join pharmacy.item i on i.id = b.item_id
      where b.on_hand > 0 and b.expiry <= $1::date order by b.expiry, i.name_search`,
    [localDate(soon)],
  );
  const withName = (r: BatchRow) => ({ ...toBatch(r, today), itemName: r.item_name! });
  const low = (await listItems(q, { today, limit: 500 })).filter((i) => i.reorderLevel > 0 && i.onHand <= i.reorderLevel);
  return {
    expired: rows.filter((r) => r.expiry < today).map(withName),
    nearExpiry: rows.filter((r) => r.expiry >= today).map(withName),
    low,
  };
}
