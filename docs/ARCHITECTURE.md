# Healthcare Suite — Offline Windows Architecture

**Products:** HMS (Hospital) · LIMS (Laboratory) · PMS (Pharmacy) · CMS (Clinic)
**Constraint:** Runs fully offline on Windows, on a single PC or a hospital LAN. No internet needed for any daily workflow.
**North-star UX goal:** A receptionist can register a patient, book an appointment and print a bill in **under 60 seconds, about 8 keystrokes/clicks, with no training.**

---

## 1. Feasibility: what "offline Windows" really means

| Question | Answer | Consequence |
|---|---|---|
| Is a single offline PC enough? | Only for a small clinic or a standalone pharmacy. A hospital has reception, doctors, lab, pharmacy and billing on **different PCs at the same time.** | You need a **LAN client–server** design. "Offline" means *no internet*, not *no network*. |
| Can one codebase serve all four products? | Yes. ~70% of the data is shared (patient, doctor, billing, users, masters, audit). | Build **one platform with licensed modules**, not four apps. |
| Can a modern UI run offline? | Yes. WebView2 is built into Windows 10/11 and can also be bundled as a fixed version. | Use web UI technology inside a native Windows shell. |
| What breaks without internet? | ABHA/ABDM, SMS/WhatsApp, online payments, cloud backup, remote updates and online licensing. | Make each one an **optional connector** that queues work and sends it when internet is available. Never block a workflow on it. |
| Biggest offline risk? | **Data loss** (dead disk, ransomware, a staff member's mistake). There is no cloud copy. | Automatic, encrypted, tested backups are a **core feature from day one**. |

**Verdict:** Fully feasible. Two decisions matter most: **LAN client–server** and **one modular platform.**

---

## 2. Deployment topologies (one installer, three modes)

```
 Mode A: Standalone (Clinic / small pharmacy)    Mode B: LAN (Hospital / Lab)
 ┌──────────────────────────┐            ┌──────────────── Server PC (or mini server) ────────────────┐
 │  Single PC               │            │  HealthSuite Server (Windows Service)                       │
 │  ┌────────┐  ┌────────┐  │            │  PostgreSQL · Backup agent · Device bridge · Sync agent     │
 │  │ Client │─▶│ Server │  │            └───────────────▲──────────────▲──────────────▲───────────────┘
 │  └────────┘  │ + DB   │  │                            │ HTTPS + WebSocket (LAN)    │
 │              └────────┘  │              ┌─────────────┴┐  ┌──────────┴─┐  ┌───────┴──────┐  ┌──────────┐
 └──────────────────────────┘              │ Reception    │  │ Doctor     │  │ Lab + analyzers│  │ Pharmacy │
                                           └──────────────┘  └────────────┘  └───────────────┘  └──────────┘
 Mode C: LAN + standby — a second PC runs a PostgreSQL streaming replica and can be promoted if the main server fails.
```

- The client and server are **the same binaries** in every mode. Only the configuration changes.
- **Zero-config discovery:** clients find the server automatically through a UDP broadcast or mDNS. Nobody types an IP address.
- Even in standalone mode the server is a separate process. A clinic that grows into a hospital adds client PCs and **does not migrate anything.**

---

## 3. Technology stack (chosen: TypeScript end to end)

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** (sandboxed, context-isolated, tiny preload bridge) | Mature on Windows. Silent printing to thermal and label printers, single-instance lock, auto-update tooling (electron-builder). Ships its own Node, so the PC needs nothing installed. |
| UI | **React + TypeScript**, Vite, TanStack Query, Tailwind v4 with semantic design tokens | Fastest way to a modern, accessible UI with keyboard-first flows. The same build runs in Electron, in any LAN browser and on token-display TVs. |
| Server | **Node.js + Fastify** (TypeScript) | One language across UI, server and shared contracts. In standalone mode it runs inside Electron as a utility process; in LAN mode it runs as a Windows Service. |
| Shared contracts | **Zod** schemas in `packages/shared` | The server validates with the same schemas the UI uses, so the two can't drift apart. |
| Realtime | WebSocket (`@fastify/websocket`) | Live queues: front desk, doctor screens, token display, and later the lab worklist and pharmacy Rx queue. |
| Database | **PostgreSQL**: **PGlite** (Postgres compiled to WASM, no install) for standalone, real **PostgreSQL** for hospital LAN | Same SQL and migrations on both. A clinic grows into a hospital with a plain `pg_dump`/restore. |
| Reports / PDF | HTML templates → Electron/Chromium print-to-PDF | One template engine for receipts, lab reports and discharge summaries. |
| Device integration | Device Bridge (Node `serialport` / TCP): ASTM E1381/E1394, HL7 v2.x, ESC/POS, ZPL | Lab analyzers, receipt and label printers. |
| Installer | electron-builder (NSIS/MSI) + signed offline update packages | Updates install from a USB stick or a LAN share. |

*Why not Tauri or .NET:* both are good, but they need the Rust or .NET toolchains plus a second language. Electron keeps the whole product in TypeScript, so one team can work on any layer.

---

## 4. Logical architecture: a modular monolith

Do not use microservices: they are operationally impossible for an offline hospital with no IT staff. Build **one server process with strictly separated modules.** Modules communicate through in-process interfaces and domain events, never through each other's tables.

```
┌──────────────────────────────────────── HealthSuite Server ────────────────────────────────────────┐
│  API layer (REST + WebSocket)  ·  AuthZ (RBAC)  ·  Licence gate (which modules are enabled)          │
├─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  PRODUCT MODULES                                                                                    │
│  ┌──────────── HMS ───────────┐ ┌──────── LIMS ────────┐ ┌──────── PMS ────────┐ ┌──── CMS ────┐   │
│  │ OPD, IPD/ADT, wards & beds │ │ Test master, panels  │ │ Item/batch/expiry   │ │ Profile of  │   │
│  │ OT, nursing, discharge     │ │ Sample & barcode     │ │ Purchase, GRN       │ │ HMS: OPD,   │   │
│  │ EMR, orders, insurance/TPA │ │ Worklist, results    │ │ Dispense / POS      │ │ Rx, billing │   │
│  │ Packages, deposits         │ │ Validation, reports  │ │ Stock transfer, GST │ │ only        │   │
│  └────────────────────────────┘ │ QC (Levey-Jennings)  │ │ Schedule H/H1 reg.  │ └─────────────┘   │
│                                 └──────────────────────┘ └─────────────────────┘                   │
├─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  SHARED CORE                                                                                         │
│  Patient master (UHID) · Practitioners & departments · Scheduling engine · Orders (one model)      │
│  Billing engine (tariffs, charges, invoices, payments, refunds, GST) · Users/roles · Audit log     │
│  Masters & settings · Document/print engine · Notifications outbox · Numbering service             │
├─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  INFRASTRUCTURE: PostgreSQL · Backup agent · Device bridge · Update agent · Sync agent (optional)   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The four products are licences, not codebases

| Product | Enabled modules |
|---|---|
| **CMS** (Clinic) | Core + OPD + simple EMR/Rx + billing. Optional mini-pharmacy and lab-orders-out. |
| **HMS** (Hospital) | Core + full HMS. LIMS and PMS add on seamlessly. |
| **LIMS** (standalone lab) | Core + LIMS + referral doctors/B2B billing. |
| **PMS** (standalone pharmacy) | Core + PMS + walk-in POS. |

When a hospital buys HMS + LIMS + PMS, a doctor's lab order shows up instantly on the lab worklist, results appear in the EMR, prescriptions appear in the pharmacy queue, and **every charge lands on one patient bill**. That integration is what you sell.

### The key cross-module flow: one order model

```
Doctor/Reception creates ORDER (lab test | drug | procedure | consult)
      │
      ├─▶ Billing engine: CHARGE created (OP: pay before; IP: posted to running bill)
      ├─▶ LIMS: sample to collect → barcode → analyzer → result → validate → report → EMR
      └─▶ PMS: Rx queue → dispense from batch (FEFO) → stock down → charge confirmed
```

---

## 5. Data architecture

**Design for future sync from day one, even though v1 is offline.** Adding sync later is cheap only if these rules hold now:

1. **UUIDv7 primary keys** everywhere. Human-readable numbers (UHID `CH-000123`, bill `INV/25-26/00042`) come from a separate **Numbering service** with a branch prefix.
2. Every table has `created_at, created_by, updated_at, updated_by, row_version`. Use **soft delete** (`deleted_at`) for clinical and financial data.
3. **Financial and clinical records are immutable.** Fix mistakes with cancellations, credit notes and amendments, never `UPDATE`/`DELETE`. NABL audits and GST rules require this.
4. **Append-only audit log** with a hash chain so tampering can be detected. It records who did what, when, from which terminal, and the before/after state.
5. **Transactional outbox table:** every SMS, WhatsApp, ABDM push or cloud-sync event is written here in the same transaction and sent when internet appears.
6. One schema per module (`core`, `hms`, `lims`, `pms`). Cross-module reads go through the owning module's service or read views only.

Core entities: `Patient`, `Encounter (OP/IP/Lab-only/Pharmacy-walk-in)`, `Appointment`, `Order`, `OrderItem`, `Charge`, `Invoice`, `Payment`, `Practitioner`, `Tariff`, `User`, `Role`, `AuditEvent`.

---

## 6. UX architecture: how this beats legacy HMS software

Legacy HMS screens are usually menu trees mirroring database tables. **This product is organised around tasks.**

### 6.1 The front-desk flow (the benchmark)

One screen, no page changes, keyboard-first:

```
[Ctrl+K]  Type phone / name / UHID ───▶ match found? ──yes──▶ patient card
                                           │ no
                                           ▼
                         Inline quick-register: Name · Age or DOB · Sex · Phone   (4 fields, Enter advances)
                                           ▼
                         Doctor & slot: next free slot preselected (Enter accepts)
                                           ▼
                         Bill auto-filled with consultation fee → Cash/UPI/Card → [F9] Pay & Print
                                           ▼
                         Token printed · queue screen updated live · doctor sees patient waiting
```

- **Phone number first.** Families share phones, so show all matches as cards.
- **Smart defaults:** last-used doctor, today's date, default payment mode, city from the clinic setting.
- **No blocking dialogs.** Show an undo toast instead of "Are you sure?" for anything reversible.
- **Drafts autosave.** A power cut or interruption loses nothing.
- Full registration (address, ID proof, insurance) is **optional and deferred**. Prompt for it later and never block on it.

### 6.2 Design-system rules

- **Role-based home screens:** reception sees the queue and today's appointments; lab sees the worklist; pharmacy sees the Rx queue and low stock; the admin sees the day's revenue.
- **Command palette** (Ctrl+K) for every action and every record. A **keyboard shortcut on every primary button**, shown on the button.
- **Accessibility (WCAG 2.2 AA):** 4.5:1 contrast, 40px+ hit targets, visible focus, font scaling to 200%, high-contrast theme, never colour alone for critical values (abnormal lab results get an icon *and* colour), screen-reader labels.
- **Multilingual UI** (English plus regional languages) from the start. Externalise strings now.
- **Patient safety cues:** allergy banner, duplicate-patient warning, drug interaction/allergy alert in pharmacy, critical lab value alert to the doctor.
- **Fast terminal switching:** a 4-digit PIN to swap users on shared terminals. Auto-lock when idle.
- Performance budget: **any screen < 300 ms, search results < 100 ms** on LAN.

---

## 7. Offline-specific subsystems (often forgotten, critical)

| Subsystem | Design |
|---|---|
| **Backup** | Hourly incremental (WAL archive) plus a nightly full `pg_dump`. AES-encrypted. Copied to a second disk and/or a USB/NAS. **Red banner on every screen if the last good backup is more than 24 h old.** One-click restore, with a monthly restore test on a scratch database. |
| **Licensing** | Offline activation: machine fingerprint → licence request file → signed licence file (Ed25519) returned by email or phone. The licence lists enabled modules, user count and expiry. Grace period, and **never lock out clinical data reads**. |
| **Updates** | Signed `.hsupdate` package delivered over USB, LAN share or optional internet. Server updates first (backup → migrate → health check → auto-rollback on failure). Clients auto-update from the server. |
| **Server down** | Clients show a clear "Server unreachable" status and retry. Optional standby replica (Mode C). UPS guidance in the install checklist. |
| **Time** | The server is the source of truth for time, and clients use server time for all records, because PC clocks drift and ruin audit trails. |
| **Hardware** | Device Bridge: barcode scanners (keyboard-wedge, works anywhere), label printers, thermal printers, cash drawer, analyzers, token display screens (a browser pointed at a server URL). |
| **Security** | TLS on the LAN (self-signed CA created at install), RBAC with field-level rules (for example, reception cannot see diagnoses), Argon2 password hashes, BitLocker guidance plus database column encryption for sensitive fields, Windows Firewall rules set by the installer. |

---

## 8. Compliance checklist (India-oriented, as MocDoc's market is)

- **DPDP Act 2023:** consent capture, purpose limitation, access logs, data export/erasure workflow.
- **GST:** HSN/SAC codes, tax-inclusive/exclusive pricing, credit notes. E-invoicing hook for pharmacies above the threshold.
- **Drugs & Cosmetics Rules:** Schedule H/H1/X registers, prescriber details, batch/expiry tracking, near-expiry returns.
- **NABL / ISO 15189 (labs):** two-level result validation, QC charts, amendment history, turnaround-time (TAT) tracking.
- **ABDM / ABHA:** optional connector. Create or link ABHA when online, queue health records for push. Scan-and-share registration through the outbox.
- **NABH (hospitals):** audit trails, consent forms, incident logs, MLC register.

---

## 9. Solution / repository layout

```
healthsuite/
├─ apps/
│  ├─ desktop/   Electron shell: standalone (starts embedded server) or LAN client; silent printing bridge
│  ├─ server/    Fastify server: db adapter (PGlite | Postgres), migrations, core services, modules
│  │  └─ src/modules/front-desk/   patients, scheduling, checkout, queue  (lims/, pms/, ipd/ follow)
│  └─ web/       React UI: features/front-desk, features/queue, components/ui (design system)
├─ packages/
│  └─ shared/    Zod schemas + types + formatting shared by server and UI
└─ docs/
```

---

## 10. Phased roadmap

| Phase | Scope | Why this order |
|---|---|---|
| **0. Foundations** (4–6 wks) | Design system, auth/RBAC, patient master, numbering, audit, backup, installer, licensing skeleton | Everything else depends on these. Backup and installer are hard to add late. |
| **1. CMS** (8–10 wks) | Front desk flow, appointments, OPD consult, Rx, billing, reports | Smallest sellable product. Proves the 60-second UX goal with real receptionists. |
| **2. PMS** (8 wks) | Inventory, purchase/GRN, POS dispensing, GST, Schedule H | High standalone demand, and it plugs into CMS Rx. |
| **3. LIMS** (10–12 wks) | Test masters, sample/barcode, worklist, results, validation, report designer, 2–3 analyzer drivers | Analyzer interfacing takes the most field testing, so start pilots early. |
| **4. HMS** (16+ wks) | IPD/ADT, beds, nursing, OT, discharge, deposits, insurance/TPA, packages | Builds on everything above. |
| **5. Connectors** | ABDM, SMS/WhatsApp, cloud backup, multi-branch sync | All ride on the outbox and UUIDv7 rules already in place. |

---

## 11. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Data loss with no cloud copy | Backup is a core feature, with a visible backup-age banner and restore drills |
| Analyzer protocol variations | Plugin driver per analyzer model, a raw-message log, a simulator for testing |
| Low-spec PCs | Lean UI bundle, one Electron window, a performance budget in CI. Target 4 GB RAM / Win10 |
| Feature creep from four products | Shared core first. CMS ships before HMS |
| Support without remote access | Diagnostic bundle export (logs + config, no patient data) and an optional remote-assist tool |
| Upgrade failures on-site | Transactional migrations, automatic pre-update backup, auto-rollback |

---

## 12. Decisions needed before coding

1. ~~**UI shell**~~: decided, Electron + TypeScript end to end (§3).
2. **First product to ship:** CMS (recommended) or another.
3. **Target market and compliance scope:** India-only or multi-country (affects tax, ID and language design).
4. **Minimum client hardware** to support.
