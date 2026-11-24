import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  gstBreakup,
  type Batch, type DaySlots, type Item, type PendingPrescription, type PharmacyBill, type Practitioner, type PurchaseSummary, type Receipt,
  type RegisterEntry, type StockAlerts, type Supplier,
} from "@ojas/shared";
import type { Db } from "../src/db/index.js";
import { makeApp, setupAdmin, userWithRole, type Client } from "./helpers.js";

const NOW = new Date(2026, 10, 20, 10, 0);
let db: Db;
let server: FastifyInstance;
let admin: Client, chemist: Client, reception: Client;
let para: Item, alpraz: Item, syrup: Item;
let supplier: Supplier;

const item = async (body: object) => {
  const res = await chemist.post("/api/pharmacy/items", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Item;
};
const purchase = (lines: object[], invoiceNo = `INV-${randomUUID().slice(0, 6)}`, key = randomUUID()) =>
  chemist.post("/api/pharmacy/purchases", { supplierId: supplier.id, invoiceNo, invoiceDate: "2026-11-19", lines, idempotencyKey: key });
const sale = (body: object) =>
  chemist.post("/api/pharmacy/sales", { customerName: "Walk-in", paymentMode: "CASH", idempotencyKey: randomUUID(), ...body });
const itemNow = async (id: string) => ((await chemist.get("/api/pharmacy/items?q=")).json() as Item[]).find((i) => i.id === id)!;

beforeAll(async () => {
  ({ db, app: server } = await makeApp(() => NOW));
  admin = await setupAdmin(server);
  chemist = (await userWithRole(server, admin, "PHARMACY", "chemist")).client;
  reception = (await userWithRole(server, admin, "RECEPTION", "desk1")).client;
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe("medicines and suppliers", () => {
  it("adds medicines; refuses duplicates and other roles", async () => {
    para = await item({ name: "Paracetamol", strength: "650 mg", form: "TAB", packSize: 15, gstRate: 12, hsn: "30049099", reorderLevel: 200 });
    alpraz = await item({ name: "Alprazolam", strength: "0.5 mg", form: "TAB", packSize: 10, gstRate: 12, schedule: "H1" });
    syrup = await item({ name: "Ambroxol syrup", strength: "100 ml", form: "SYRUP", packSize: 1, gstRate: 12, schedule: "H" });
    expect(para.onHand).toBe(0);
    const dup = await chemist.post("/api/pharmacy/items", { name: "  paracetamol ", strength: "650 mg", form: "TAB", packSize: 15 });
    expect(dup.statusCode).toBe(409);
    expect((await reception.post("/api/pharmacy/items", { name: "X drug", form: "TAB", packSize: 10 })).statusCode).toBe(403);
    expect((await reception.get("/api/pharmacy/items")).statusCode).toBe(403);
    expect((await chemist.post("/api/pharmacy/items", { name: "Bad", form: "TAB", packSize: 10, gstRate: 7 })).statusCode).toBe(400);

    const s = await chemist.post("/api/pharmacy/suppliers", { name: "Sri Balaji Pharma Distributors", gstin: "33abcde1234f1z5", phone: "044 2222" });
    expect(s.statusCode, s.body).toBe(201);
    supplier = s.json();
    expect(supplier.gstin).toBe("33ABCDE1234F1Z5");
  });
});

describe("purchases", () => {
  it("receives an invoice into batches; free packs add stock but not cost", async () => {
    const key = randomUUID();
    const lines = [
      { itemId: para.id, batchNo: "p0", expiry: "2026-12", packs: 2, ratePerPack: 2000, mrpPerPack: 3000, gstRate: 12 },
      { itemId: para.id, batchNo: "P1", expiry: "2027-06", packs: 10, freePacks: 1, ratePerPack: 2100, mrpPerPack: 3240, gstRate: 12 },
      { itemId: alpraz.id, batchNo: "A1", expiry: "2027-09", packs: 3, ratePerPack: 1500, mrpPerPack: 2500, gstRate: 12 },
      { itemId: syrup.id, batchNo: "S1", expiry: "2027-03", packs: 5, ratePerPack: 6000, mrpPerPack: 9500, gstRate: 12 },
    ];
    const res = await purchase(lines, "SB-1001", key);
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json() as PurchaseSummary;
    expect(p.purchaseNo).toBe("GRN/26-27/000001");
    expect(p.taxable).toBe(2 * 2000 + 10 * 2100 + 3 * 1500 + 5 * 6000);
    expect(p.tax).toBe(Math.round(4000 * 0.12) + Math.round(21000 * 0.12) + Math.round(4500 * 0.12) + Math.round(30000 * 0.12));

    // A retry of the same request doesn't receive the stock twice.
    expect((await purchase(lines, "SB-1001", key)).json().id).toBe(p.id);
    // Entering the same supplier invoice again is refused.
    expect((await purchase(lines, "SB-1001")).json().code).toBe("invoice_already_entered");

    para = await itemNow(para.id);
    expect(para.onHand).toBe(2 * 15 + 11 * 15);
    expect(para.nextExpiry).toBe("2026-12-31");
    expect(para.mrpPerPack).toBe(3000); // the batch that sells next
  });

  it("refuses an expired batch and a batch number already held with another expiry", async () => {
    const expired = await purchase([{ itemId: para.id, batchNo: "OLD", expiry: "2026-10", packs: 1, ratePerPack: 100, mrpPerPack: 200, gstRate: 12 }]);
    expect(expired.statusCode).toBe(422);
    expect(expired.json().details.fields).toHaveProperty("lines.0.expiry");
    const clash = await purchase([{ itemId: para.id, batchNo: "P1", expiry: "2027-07", packs: 1, ratePerPack: 2100, mrpPerPack: 3240, gstRate: 12 }]);
    expect(clash.json().details.fields["lines.0.expiry"]).toContain("Jun 2027");
    // Same batch, same price, same expiry: more stock on the same line.
    expect((await purchase([{ itemId: para.id, batchNo: "P1", expiry: "2027-06", packs: 1, ratePerPack: 2100, mrpPerPack: 3240, gstRate: 12 }])).statusCode).toBe(201);
    const batches = (await chemist.get(`/api/pharmacy/items/${para.id}/batches`)).json() as Batch[];
    expect(batches.map((b) => [b.batchNo, b.onHand])).toEqual([["P0", 30], ["P1", 180]]);
  });
});

describe("selling", () => {
  it("sells the earliest expiry first, across batches, with GST worked back from MRP", async () => {
    const res = await sale({ lines: [{ itemId: para.id, qty: 40 }], customerPhone: "98400 12345" });
    expect(res.statusCode, res.body).toBe(201);
    const bill = res.json() as PharmacyBill;
    expect(bill.billNo).toBe("PH/26-27/000001");
    expect(bill.lines.map((l) => [l.batchNo, l.qty, l.amount])).toEqual([["P0", 30, 6000], ["P1", 10, 2160]]);
    expect(bill.total).toBe(8160);
    expect(bill.customerPhone).toBe("9840012345");
    expect(bill.gst).toEqual(gstBreakup([{ amount: 6000, gstRate: 12 }, { amount: 2160, gstRate: 12 }], 0));
    const g = bill.gst[0]!;
    expect(g.taxable + g.cgst + g.sgst).toBe(8160);
    expect(g.cgst + g.sgst).toBe(Math.round((8160 * 12) / 112));
    expect((await itemNow(para.id)).onHand).toBe(170);
    expect((await chemist.get(`/api/pharmacy/sales/${bill.id}`)).json().billNo).toBe(bill.billNo);
  });

  it("refuses more than is in stock and leaves stock untouched", async () => {
    const res = await sale({ lines: [{ itemId: syrup.id, qty: 1 }, { itemId: para.id, qty: 1000 }], prescriber: "Dr. Ananya" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("out_of_stock");
    expect(res.json().details.fields["lines.1.qty"]).toBe("Only 170 in stock");
    expect((await itemNow(para.id)).onHand).toBe(170);
    expect((await itemNow(syrup.id)).onHand).toBe(5);
  });

  it("needs the prescriber for scheduled medicines and records them in the register", async () => {
    const without = await sale({ lines: [{ itemId: alpraz.id, qty: 10 }] });
    expect(without.json().details.fields).toHaveProperty("prescriber");
    const ok = await sale({ lines: [{ itemId: alpraz.id, qty: 10 }, { itemId: syrup.id, qty: 1 }], prescriber: "Dr. Ananya Rao", customerName: "Kumar S" });
    expect(ok.statusCode, ok.body).toBe(201);

    const h1 = (await chemist.get("/api/pharmacy/register?from=2026-11-20")).json() as RegisterEntry[];
    expect(h1).toHaveLength(1);
    expect(h1[0]).toMatchObject({ itemName: "Alprazolam 0.5 mg", schedule: "H1", qty: 10, prescriber: "Dr. Ananya Rao", customerName: "Kumar S", batchNo: "A1" });
    const all = (await chemist.get("/api/pharmacy/register?from=2026-11-20&schedule=H,H1,X")).json() as RegisterEntry[];
    expect(all.map((r) => r.schedule).sort()).toEqual(["H", "H1"]);
    expect((await chemist.get("/api/pharmacy/register?from=2026-11-21")).json()).toHaveLength(0);
  });

  it("applies a discount before tax and only for those allowed", async () => {
    const res = await sale({ lines: [{ itemId: syrup.id, qty: 2 }], prescriber: "Dr. X", discount: 1000 });
    const bill = res.json() as PharmacyBill;
    expect(bill.total).toBe(19000 - 1000);
    const g = bill.gst[0]!;
    expect(g.taxable + g.cgst + g.sgst).toBe(18000);
    expect((await sale({ lines: [{ itemId: syrup.id, qty: 1 }], prescriber: "Dr. X", discount: 99999 })).json().code).toBe("discount_too_large");
  });
});

describe("stock", () => {
  it("adjusts with a reason, never below zero", async () => {
    const [p1] = ((await chemist.get(`/api/pharmacy/items/${para.id}/batches`)).json() as Batch[]).filter((b) => b.batchNo === "P1");
    const res = await chemist.post("/api/pharmacy/stock/adjust", { batchId: p1!.id, qty: -5, reason: "DAMAGED", note: "Strip torn" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Batch).onHand).toBe(165);
    expect((await chemist.post("/api/pharmacy/stock/adjust", { batchId: p1!.id, qty: 5, reason: "DAMAGED" })).statusCode).toBe(400);
    expect((await chemist.post("/api/pharmacy/stock/adjust", { batchId: p1!.id, qty: -999, reason: "COUNT" })).statusCode).toBe(422);
    expect((await chemist.post("/api/pharmacy/stock/adjust", { batchId: p1!.id, qty: 2, reason: "COUNT", note: "Found in drawer" })).statusCode).toBe(200);
  });

  it("flags expired, soon-expiring and low stock; expired stock is never sold", async () => {
    await db.query("update pharmacy.batch set expiry = '2026-11-01' where batch_no = 'S1'");
    const alerts = (await chemist.get("/api/pharmacy/stock/alerts")).json() as StockAlerts;
    expect(alerts.expired.map((b) => b.batchNo)).toEqual(["S1"]);
    expect(alerts.low.map((i) => i.id)).toContain(para.id); // 167 left, reorder at 200
    expect((await itemNow(syrup.id)).onHand).toBe(0);
    expect((await sale({ lines: [{ itemId: syrup.id, qty: 1 }], prescriber: "Dr. X" })).json().code).toBe("out_of_stock");
    const s1 = ((await chemist.get(`/api/pharmacy/items/${syrup.id}/batches`)).json() as Batch[])[0]!;
    expect(s1.expired).toBe(true);
    expect((await sale({ lines: [{ itemId: syrup.id, qty: 1, batchId: s1.id }], prescriber: "Dr. X" })).json().code).toBe("batch_expired");
  });

  it("keeps the ledger in step with stock, and the audit trail intact", async () => {
    const { rows } = await db.query<{ batch_no: string; on_hand: number; moved: number }>(
      `select b.batch_no, b.on_hand, (select coalesce(sum(qty), 0)::int from pharmacy.stock_move m where m.batch_id = b.id) as moved from pharmacy.batch b`,
    );
    for (const r of rows) expect(r.moved, r.batch_no).toBe(r.on_hand);
    expect((await admin.get("/api/audit/verify")).json().ok).toBe(true);
  });
});

describe("prescriptions at the counter", () => {
  it("lists today's signed prescriptions matched to stock until they are billed", async () => {
    const doctor = (await userWithRole(server, admin, "DOCTOR", "drananya")).client;
    const practitioner = ((await admin.get("/api/practitioners")).json() as Practitioner[])[0]!;
    const patient = (await admin.post("/api/patients", { name: "Meena Raj", sex: "F", phone: "9876501234", ageYears: 35 })).json();
    const slot = ((await admin.get(`/api/practitioners/${practitioner.id}/slots?date=2026-11-20`)).json() as DaySlots).slots.find((s) => s.available)!;
    const appt = ((await admin.post("/api/front-desk/checkout", {
      patientId: patient.id, practitionerId: practitioner.id, slotStart: slot.start, paymentMode: "CASH", idempotencyKey: randomUUID(),
    })).json() as Receipt).appointmentId;
    await doctor.put(`/api/consult/${appt}/notes`, {
      notesVersion: 0, chiefComplaint: "Fever",
      medications: [
        { drug: "Tab. Paracetamol 650", dose: "1 tab", frequency: "1-0-1", durationDays: 5 },
        { drug: "Tab. Unknownium", frequency: "SOS" },
      ],
    });
    expect((await chemist.get("/api/pharmacy/prescriptions")).json()).toHaveLength(0); // not signed yet
    await doctor.post(`/api/consult/${appt}/sign`);

    const pending = (await chemist.get("/api/pharmacy/prescriptions")).json() as PendingPrescription[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ patientName: "Meena Raj", prescriber: practitioner.name });
    expect(pending[0]!.lines[0]).toMatchObject({ drug: "Tab. Paracetamol 650", suggestedQty: 10, item: { id: para.id } });
    expect(pending[0]!.lines[1]!.item).toBeNull();

    const res = await sale({ patientId: patient.id, appointmentId: appt, customerName: "Meena Raj", prescriber: practitioner.name, lines: [{ itemId: para.id, qty: 10 }] });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as PharmacyBill).uhid).toBe(patient.uhid);
    expect((await chemist.get("/api/pharmacy/prescriptions")).json()).toHaveLength(0);
  });
});
