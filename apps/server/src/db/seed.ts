import type { Db } from "./index.js";
import { uuidv7 } from "../core/ids.js";

/**
 * First-run defaults so a fresh install is usable immediately. The setup wizard (to come) replaces
 * these with the facility's real details. Seeds only an empty database and never overwrites data.
 */
export async function seedIfEmpty(db: Db): Promise<void> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from core.facility");
  if (rows[0]?.n) return;

  await db.tx(async (q) => {
    await q.query(
      "insert into core.facility (id, name, address, phone, uhid_prefix) values (1, $1, $2, $3, 'HS-')",
      ["HealthSuite Demo Clinic", "12 Gandhi Road, Chennai 600001", "044-2345 6789"],
    );
    const doctors: [string, string, number, number, string, string][] = [
      // name, department, fee (paise), slot minutes, day start, day end
      ["Dr. Ananya Rao", "General Medicine", 50_000, 10, "08:00", "20:00"],
      ["Dr. Vikram Iyer", "Paediatrics", 60_000, 15, "09:00", "17:00"],
      ["Dr. Meera Krishnan", "Gynaecology", 80_000, 15, "10:00", "18:00"],
      ["Dr. Arjun Shah", "Orthopaedics", 70_000, 15, "08:00", "20:00"],
    ];
    for (const [name, dept, fee, slot, start, end] of doctors) {
      await q.query(
        `insert into core.practitioner (id, name, department, consultation_fee, slot_minutes, day_start, day_end)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidv7(), name, dept, fee, slot, start, end],
      );
    }
  });
}
