# Ojas

*Ojas (ओजस्), Sanskrit for vitality and inner strength.*

An offline-first healthcare suite for Windows: **Hospital (HMS) · Laboratory (LIMS) · Pharmacy (PMS) · Clinic (CMS)**, all on one platform.
Design goal: a receptionist registers a patient, books an appointment and prints a bill in under a minute, with no training.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## What works today (Phase 1 slice: front desk)

- **One-screen front desk:** search (phone, name or UHID) → 4-field quick registration → doctor and slot → bill and payment → token and receipt.
- Returning patient: **5 digits, Enter, Enter, F9**. Every action has a keyboard shortcut, shown on its button.
- Duplicate-patient guard, gap-free UHID, invoice (per financial year) and token numbering.
- Atomic, idempotent checkout: a double-press or network retry never double-books or double-charges, and the database prevents two desks booking the same slot.
- Live OPD queue over WebSocket across all LAN terminals.
- Hash-chained, tamper-evident audit trail (`GET /api/audit/verify`), plus an outbox ready for SMS/ABDM.
- 80 mm thermal receipt layout. The desktop app prints silently.
- Light and dark themes, WCAG-minded focus, labels and contrast.

### Sign-in and roles

- **First run** asks for the administrator account. There are no default passwords.
- **Roles:** Administrator, Reception, Accounts, Doctor, Nurse, Laboratory, Pharmacy. Each sees only the screens it can use, and the server enforces every permission (one shared table in `packages/shared/src/auth.ts`).
- **Shared desks:** the desk locks after 5 minutes idle or on <kbd>Ctrl</kbd>+<kbd>L</kbd>. To unlock, tap your name and type your 4–6 digit PIN. Easy PINs are rejected.
- **Staff accounts:** an admin adds a user with a one-time temporary password. At first sign-in the user must choose their own password and a PIN.
- **Protection:** 5 wrong attempts lock the account for 5 minutes. Sessions end after 30 minutes idle or 12 hours. Deactivating a user, resetting their password or changing their role signs them out everywhere.
- **Storage:** passwords and PINs are hashed with scrypt, and session tokens are stored only as SHA-256. The session cookie is HttpOnly and SameSite=Strict.
- **Discounts** need the Accounts or Administrator role. Every action is audited under the real user and desk.

### Clinic setup

- **First-run wizard:** right after the administrator account, three short steps: clinic details (printed on receipts), doctors with fees and consulting hours, then a summary. Nothing is pre-filled with demo data. Other roles see "still being set up" until it's finished.
- **Doctors and timings:** up to 3 sessions a day (morning and evening clinics), set per weekday, with one-click presets and "Copy to Tue–Sat". Slot length is 5–60 minutes. Overlapping or too-short sessions are rejected, with the problem highlighted. Inactive doctors disappear from the front desk; their history stays.
- **Holidays and leave:** a clinic holiday closes the day for everyone; doctor leave closes only that doctor's days. The front desk shows why ("Clinic closed: Pongal", "Dr. X is on leave (Conference), back Thu 26 Nov") and the server refuses bookings on those days. Adding one tells you how many patients are already booked, so they can be called.
- **Settings page** (<kbd>Alt</kbd>+<kbd>8</kbd>, administrators): doctors and timings, holidays and leave, clinic details. Changes apply to new bookings only. The patient ID prefix locks after the first patient. Every change is in the audit trail.

### OPD consultation

- **Doctor's screen** (<kbd>Alt</kbd>+<kbd>3</kbd>, doctors and administrators): today's patients for the chosen doctor on the left (remembered per desk). <kbd>Alt</kbd>+<kbd>N</kbd> calls the next waiting patient in and opens their record.
- **One form:** vitals, complaints, history, examination, diagnoses (optional ICD-10 code), medicines (dose, 1-0-1 style frequency, before/after food, days, notes), tests, advice and a review date (one click for 3 days, 1 week, 2 weeks or 1 month). It saves itself about a second after the doctor stops typing.
- **Faster prescribing:** diagnoses, medicines and tests suggest what the clinic has written before, most used first. Picking a medicine fills in the dose and frequency it was last given with. "Repeat medicines" copies an earlier prescription from the patient's past visits, shown beside the form.
- **Vitals at triage:** nurses record temperature (°F), pulse, BP, SpO₂, breathing rate, weight, height (BMI is worked out) and blood sugar from the OPD queue. Out-of-range readings are coloured. Vitals and the doctor's notes are saved separately, so a nurse and a doctor working on the same visit never overwrite each other. A screen with an out-of-date copy is refused rather than overwriting.
- **Sign & print** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>): locks the record, marks the visit done and prints an A5 prescription with the doctor's name, qualification and registration number. In the desktop app it opens the print dialog, so it doesn't go to the receipt printer.
- **Corrections:** a signed record is changed only through "Correct", which needs a reason. Every signed version is kept exactly as signed (`GET /api/consult/:appointmentId/versions`), and signing and corrections are in the audit trail.
- Tests ordered here appear at the laboratory desk, and verified results show beside the consultation.

### Pharmacy

- **Pharmacy screen** (<kbd>Alt</kbd>+<kbd>4</kbd>, Pharmacy role and administrators; Accounts sees the register only), with tabs for Sell, Stock & expiry, Purchases, Medicines and the Schedule H1 register.
- **Medicines:** brand, strength, form, generic name, units per pack, GST rate and HSN, drug schedule (H, H1, X) and a reorder level. Units per pack locks once stock has been received.
- **Purchases:** enter a supplier invoice line by line (batch, expiry month, packs, free packs, rate, MRP, GST) and check the total against the paper invoice. Each one gets a goods receipt number (`GRN/26-27/000001`). The same invoice can't be entered twice, expired batches are refused, and a batch number that comes back with a different expiry is flagged.
- **Selling** (<kbd>F2</kbd> to add a medicine, <kbd>F9</kbd> to bill): stock always leaves from the batch that expires first, and expired stock is never sold. Strips can be cut (15 tablets from a strip of 10 is priced pro rata from MRP). Schedule H, H1 and X medicines need the prescribing doctor's name. Discounts need the discount permission. Bills are numbered `PH/26-27/000001`.
- **From the consultation:** today's signed prescriptions that haven't been dispensed are listed. One click fills in the patient, the doctor and the medicines, matched by name or generic name, with quantities worked out from dose × days. Medicines the pharmacy doesn't stock are named so they can be skipped or added by hand.
- **GST:** MRP includes GST. The 80 mm bill shows each line's batch and expiry, the drug licence number and GSTIN, and a CGST/SGST table per rate, with any discount shared across the lines.
- **Stock & expiry:** expired stock still on the shelf, stock expiring within 90 days, and medicines below their reorder level. Each batch shows its stock, and corrections (expired, damaged, returned to supplier, a stock count, or other) need a reason. Only a count can add stock. Every movement is recorded and audited.
- **Schedule H1 register:** date, bill, patient, prescriber, medicine, batch and quantity for any period, H1 and X by default or all scheduled medicines, printable on A4 for inspection.

### Laboratory

- **Laboratory screen** (<kbd>Alt</kbd>+<kbd>5</kbd>, Laboratory role and administrators; Reception can bill tests), with tabs for the Worklist, New order and Tests & prices.
- **Test catalogue:** each test has a code, section, sample type, price, turnaround time and its parameters (numeric, text or a fixed choice). Each numeric parameter can have reference ranges by sex and age, with critical limits. "Add common tests" loads 18 everyday tests (CBC, sugars, lipid, LFT, RFT, thyroid, dengue, urine and more) with adult ranges, ready to be priced.
- **Billing** (<kbd>F2</kbd> to add a test, <kbd>F9</kbd> to bill): pick a patient, or a test request from a doctor's signed consultation in the last three days, which fills in the patient, the doctor and the matching tests. Unpriced and inactive tests can't be billed, and discounts need the discount permission. Bills are numbered `LAB/26-27/000001`.
- **Samples:** one sample per container type, each with an accession number (`261125-001`) and a 50 × 25 mm barcode label. A scanned label opens its order. A rejected sample (haemolysed, clotted) needs a reason, and its tests go back to waiting for a new sample.
- **Results:** typed in like a worksheet (<kbd>Enter</kbd> moves to the next box). The reference range for the patient's age and sex is shown, values are flagged Low, High or Critical as they are typed, and critical values raise a warning. Results are then verified, which locks them. Changing a verified result needs a reason, and the earlier values are kept in the audit trail.
- **Report:** an A4 report grouped by section, with flags, reference ranges, sample details, the method, and who verified it. A partial report says how many tests are still in progress.
- **Doctor's view:** verified results, newest first with abnormal values marked, appear beside the consultation.

### Backups

- **Encrypted:** each backup is one `.ojasbak` file with the whole database, encrypted with AES-256-GCM using a key derived (scrypt) from a backup password the administrator sets once. The clinic name and date stay readable, so backups can be listed without the password.
- **Two places:** a main folder (default: `backups` next to the database) and a second copy, ideally on a USB drive or another disk. Each file is read back and decrypted after writing. If the USB copy fails, the backup still counts and a warning shows.
- **Automatic:** every 1–24 hours (default 4) while Ojas runs, starting about a minute after start-up if one is due. "Back up now" is one click. The newest 30 are kept in each folder (adjustable).
- **Warnings:** administrators see a banner on every screen when backups are off, the last one failed, or the newest is over a day old.
- **One-step restore** (Settings → Backups): type RESTORE to confirm. A safety backup of the current data is taken first, so a restore can be undone. Everyone is signed out. This install's backup settings and history are kept.
- **New or rebuilt PC:** the first-run screen offers "Restore from a backup": point it at the USB folder and enter the backup password.
- **External PostgreSQL** (hospital LAN servers) is backed up with PostgreSQL's own tools instead.

### Clinic network

- **Three ways to run a PC**, picked on first start (and later from your name → *This PC's connection…*): **this PC only** (standalone), **main server for the clinic**, or **a desk on the clinic network**.
- **Server as a Windows Service** ("Ojas Server"): keeps serving every desk with nobody signed in to Windows, starts at boot, restarts after a crash, and stops cleanly so the database flushes. Choosing "main server" asks for administrator approval once. It also opens the firewall for private and domain networks only (TCP 4870, UDP 4872) and locks `%ProgramData%\Ojas\data` to SYSTEM and Administrators. The log is `%ProgramData%\Ojas\data\logs\server.log`.
- **HTTPS on the network:** each server makes its own certificate on first start (`%ProgramData%\Ojas\tls`, valid 10 years) and the session cookie is `Secure`. The certificate's fingerprint is shown as a **server code** (`D2A3-693A-BCED-D06A`), in Settings → This server and on the desk when pairing. The desk pins it, so it never talks to a different machine on the same address.
- **Desks find the server by themselves:** the desk sends a UDP broadcast and lists every server that answers; you can also type an address. If the server's address changes later, the desk looks again for the same server code and reconnects without asking.

## Run it

Needs Node.js 22+ only.

```powershell
npm install
```

Run the server and UI together, then open http://localhost:5173:

```powershell
npm run dev
```

Or start with a demo clinic and four doctors already set up (skips the wizard on an empty database):

```powershell
npm run dev:demo
```

Run the same, plus the Electron window:

```powershell
npm run dev:desktop
```

Run the server's integration tests (in-memory Postgres):

```powershell
npm test -w @ojas/server
```

Build everything, then start the desktop app in standalone mode (it starts its own server):

```powershell
npm run build; npm start -w @ojas/desktop
```

Build the Windows installer (`apps/desktop/release/Ojas-Setup-<version>.exe`; per-machine, includes the server, the UI and the service host):

```powershell
npm run dist -w @ojas/desktop
```

The installer and `OjasService.exe` are not code-signed yet. Windows Smart App Control blocks unsigned programs, so on a PC with it turned on the build stops at the NSIS step and the service host won't run. Build and test on a PC without Smart App Control, and sign the release before giving it to clinics.

| Env var | Meaning | Default |
|---|---|---|
| `OJAS_PORT` / `OJAS_HOST` | Server bind | `4870` / `127.0.0.1` (use `0.0.0.0` for a LAN server) |
| `OJAS_DB_URL` | Use real PostgreSQL instead of the embedded database | — |
| `OJAS_DATA_DIR` | Embedded database folder | `apps/server/.data/db` in dev, `%ProgramData%\Ojas\data\db` in desktop |
| `OJAS_WEB_DIR` | Built UI to serve to LAN browsers | — |
| `OJAS_BACKUP_DIR` | Default main backup folder | `backups` beside the database folder |
| `OJAS_MODE` | `standalone`, `server` or `client`, shown in Settings → This server | `standalone` |
| `OJAS_TLS` / `OJAS_TLS_DIR` | `1` serves HTTPS with this server's own certificate, kept in this folder | off / `tls` beside the data folder |
| `OJAS_DISCOVERY` | `1` answers desks looking for a server (UDP 4872) | off |
| `OJAS_STDIN_CONTROL` | `1` stops cleanly when "shutdown" arrives on stdin (used by the service host) | off |
| `OJAS_DEMO` | `1` fills an empty database with a demo clinic and doctors | — |

The desktop app saves its choice in its user data folder. To set it for every user on a PC, put the same JSON in `%ProgramData%\Ojas\desktop.json`: `{"mode":"standalone"}`, or `{"mode":"client","serverUrl":"https://192.168.1.10:4870","fingerprint":"<SHA-256 of the server certificate>"}`. A PC with the Ojas Server service installed always runs as the server.

## Not done yet (next milestones)

1. Offline licensing (signed licence file) and updates from USB; code-signing the installer.
2. Rescheduling bookings hit by a new holiday or leave, bill cancellation and refunds, and a day-end cash report.
3. Admin-editable role permissions, and linking doctor accounts to their practitioner record, so the consultation screen opens on the right doctor without asking.
4. Pharmacy: sales returns, supplier returns and credit notes, GSTR-1 / purchase GST reports, and barcode scanning.
5. Laboratory: analyser interfacing, outsourced tests, sending reports to patients (print-out, WhatsApp or email), and age-specific ranges for children.
6. Then the modules: IPD.
