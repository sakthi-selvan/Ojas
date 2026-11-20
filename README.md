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

### Backups

- **Encrypted:** each backup is one `.ojasbak` file with the whole database, encrypted with AES-256-GCM using a key derived (scrypt) from a backup password the administrator sets once. The clinic name and date stay readable, so backups can be listed without the password.
- **Two places:** a main folder (default: `backups` next to the database) and a second copy, ideally on a USB drive or another disk. Each file is read back and decrypted after writing. If the USB copy fails, the backup still counts and a warning shows.
- **Automatic:** every 1–24 hours (default 4) while Ojas runs, starting about a minute after start-up if one is due. "Back up now" is one click. The newest 30 are kept in each folder (adjustable).
- **Warnings:** administrators see a banner on every screen when backups are off, the last one failed, or the newest is over a day old.
- **One-step restore** (Settings → Backups): type RESTORE to confirm. A safety backup of the current data is taken first, so a restore can be undone. Everyone is signed out. This install's backup settings and history are kept.
- **New or rebuilt PC:** the first-run screen offers "Restore from a backup": point it at the USB folder and enter the backup password.
- **External PostgreSQL** (hospital LAN servers) is backed up with PostgreSQL's own tools instead.

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

| Env var | Meaning | Default |
|---|---|---|
| `OJAS_PORT` / `OJAS_HOST` | Server bind | `4870` / `127.0.0.1` (use `0.0.0.0` for a LAN server) |
| `OJAS_DB_URL` | Use real PostgreSQL instead of the embedded database | — |
| `OJAS_DATA_DIR` | Embedded database folder | `apps/server/.data/db` in dev, `%ProgramData%\Ojas\data\db` in desktop |
| `OJAS_WEB_DIR` | Built UI to serve to LAN browsers | — |
| `OJAS_BACKUP_DIR` | Default main backup folder | `backups` beside the database folder |
| `OJAS_DEMO` | `1` fills an empty database with a demo clinic and doctors | — |

Desktop mode is set in `%ProgramData%\Ojas\desktop.json`: `{"mode":"standalone"}` or `{"mode":"client","serverUrl":"http://192.168.1.10:4870"}`.

## Not done yet (next milestones)

1. Installer (electron-builder), Windows Service for LAN servers with HTTPS (then the session cookie becomes `Secure`), LAN server auto-discovery, offline licensing.
2. Rescheduling bookings hit by a new holiday or leave, bill cancellation and refunds, and a day-end cash report.
3. Admin-editable role permissions, and linking doctor accounts to their practitioner record ("my patients").
4. Then the modules: Pharmacy, LIMS, OPD consultation/EMR, IPD.
