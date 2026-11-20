# HealthSuite

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
npm test -w @hs/server
```

Build everything, then start the desktop app in standalone mode (it starts its own server):

```powershell
npm run build; npm start -w @hs/desktop
```

| Env var | Meaning | Default |
|---|---|---|
| `HS_PORT` / `HS_HOST` | Server bind | `4870` / `127.0.0.1` (use `0.0.0.0` for a LAN server) |
| `HS_DB_URL` | Use real PostgreSQL instead of the embedded database | — |
| `HS_DATA_DIR` | Embedded database folder | `apps/server/.data/db` in dev, `%ProgramData%\HealthSuite\data\db` in desktop |
| `HS_WEB_DIR` | Built UI to serve to LAN browsers | — |

Desktop mode is set in `%ProgramData%\HealthSuite\desktop.json`: `{"mode":"standalone"}` or `{"mode":"client","serverUrl":"http://192.168.1.10:4870"}`.

## Not done yet (next milestones)

1. Sign-in, roles and PIN user-switching. Today the audit trail records the terminal ID and the user `reception`.
2. Setup wizard (facility details, doctors, fees, schedules) and masters screens. Doctors are seeded with demo data.
3. Automatic encrypted backups with a backup-age banner, and restore.
4. Installer (electron-builder), Windows Service for LAN servers, LAN server auto-discovery, offline licensing.
5. Then the modules: Pharmacy, LIMS, OPD consultation/EMR, IPD.
