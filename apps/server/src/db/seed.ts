import type { Db } from "./index.js";
import { uuidv7 } from "../core/ids.js";

/**
 * Every install needs exactly one facility row. A real install starts blank: the first-run wizard
 * asks for the clinic's details and doctors. Never overwrites existing data.
 */
export async function ensureFacility(db: Db): Promise<void> {
  await db.query(
    `insert into core.facility (id, name, uhid_prefix, setup_completed) values (1, '', 'OJ-', false) on conflict (id) do nothing`,
  );
}

/**
 * Demo data for development, screenshots and tests (OJAS_DEMO=1): a named clinic and four doctors,
 * with setup marked complete. Only fills a database that has no doctors yet.
 */
export async function seedDemo(db: Db): Promise<void> {
  await ensureFacility(db);
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from core.practitioner");
  if (rows[0]?.n) return;

  await db.tx(async (q) => {
    await q.query(
      `update core.facility set name = $1, address = $2, phone = $3, setup_completed = true where id = 1`,
      ["Ojas Demo Clinic", "12 Gandhi Road, Chennai 600001", "044-2345 6789"],
    );
    const everyDay = [0, 1, 2, 3, 4, 5, 6];
    const doctors: [string, string, number, number, [string, string][]][] = [
      // name, department, fee (paise), slot minutes, daily sessions
      ["Dr. Ananya Rao", "General Medicine", 50_000, 10, [["08:00", "20:00"]]],
      ["Dr. Vikram Iyer", "Paediatrics", 60_000, 15, [["09:00", "13:00"], ["16:00", "19:00"]]],
      ["Dr. Meera Krishnan", "Gynaecology", 80_000, 15, [["10:00", "18:00"]]],
      ["Dr. Arjun Shah", "Orthopaedics", 70_000, 15, [["08:00", "20:00"]]],
    ];
    for (const [name, dept, fee, slot, sessions] of doctors) {
      const id = uuidv7();
      await q.query(
        `insert into core.practitioner (id, name, department, consultation_fee, slot_minutes, qualification) values ($1,$2,$3,$4,$5,'MBBS')`,
        [id, name, dept, fee, slot],
      );
      for (const d of everyDay) {
        for (const [start, end] of sessions) {
          await q.query(
            "insert into core.practitioner_session (id, practitioner_id, weekday, start_time, end_time) values ($1,$2,$3,$4,$5)",
            [uuidv7(), id, d, start, end],
          );
        }
      }
    }
  });
}
