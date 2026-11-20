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

## Run it

Needs Node.js 22+ only.

```powershell
npm install
```

Run the server and UI together, then open http://localhost:5173:

```powershell
npm run dev
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

Desktop mode is set in `%ProgramData%\Ojas\desktop.json`: `{"mode":"standalone"}` or `{"mode":"client","serverUrl":"http://192.168.1.10:4870"}`.

## Not done yet (next milestones)

1. Setup wizard (facility details, doctors, fees, schedules) and masters screens. Doctors are seeded with demo data.
2. Automatic encrypted backups with a backup-age banner, and restore.
3. Installer (electron-builder), Windows Service for LAN servers with HTTPS (then the session cookie becomes `Secure`), LAN server auto-discovery, offline licensing.
4. Admin-editable role permissions, and linking doctor accounts to their practitioner record ("my patients").
5. Then the modules: Pharmacy, LIMS, OPD consultation/EMR, IPD.
