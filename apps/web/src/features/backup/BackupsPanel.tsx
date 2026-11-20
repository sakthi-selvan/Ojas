import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, DatabaseBackup, HardDrive, History, Usb } from "lucide-react";
import { BackupConfigInput, type BackupRun, type BackupStatus } from "@ojas/shared";
import { api, agoLabel, dateTimeLabel, sizeLabel } from "../../lib/api";
import { Alert, Badge, Button, Card, Field, Select } from "../../components/ui";
import { formErrors } from "../settings/forms";
import { RestorePanel } from "./RestorePanel";

const INTERVALS = [1, 2, 4, 6, 12, 24];

/** Settings → Backups: status and "Back up now", where and how often, history, and restore. */
export function BackupsPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["backup-status"], queryFn: api.backupStatus, refetchInterval: 30_000 });
  const runs = useQuery({ queryKey: ["backup-runs"], queryFn: api.backupRuns });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["backup-status"] });
    void qc.invalidateQueries({ queryKey: ["backup-runs"] });
    void qc.invalidateQueries({ queryKey: ["backup-files"] });
  };
  const now = useMutation({ mutationFn: api.backupNow, onSettled: refresh });

  if (status.error) return <Alert tone="danger">{status.error.message}</Alert>;
  if (!status.data) return <p className="text-sm text-ink-3">Loading…</p>;
  const s = status.data;
  if (!s.supported) {
    return (
      <Alert tone="warn">
        This server uses an external PostgreSQL database. Back it up with PostgreSQL's own tools (pg_dump or replication), which your IT team manages.
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {s.configured && (
        <Card className="flex flex-wrap items-center gap-4 p-4">
          {s.lastSuccess ? (
            <CheckCircle2 aria-hidden className="size-8 shrink-0 text-ok" />
          ) : (
            <CircleAlert aria-hidden className="size-8 shrink-0 text-warn" />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {s.lastSuccess ? `Last backup ${agoLabel(s.lastSuccess.startedAt)}` : "No backup yet"}
            </div>
            <div className="text-sm text-ink-2">
              {s.lastSuccess && `${dateTimeLabel(s.lastSuccess.startedAt)} · ${sizeLabel(s.lastSuccess.bytes ?? 0)} · `}
              Automatic every {s.intervalHours} hour{s.intervalHours === 1 ? "" : "s"} while Ojas is running
              {s.nextDueAt && Date.parse(s.nextDueAt) > Date.now() && `, next around ${new Date(s.nextDueAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`}
            </div>
          </div>
          <Button variant="primary" onClick={() => now.mutate()} disabled={now.isPending || s.running}>
            <DatabaseBackup aria-hidden className="size-4" /> {now.isPending || s.running ? "Backing up…" : "Back up now"}
          </Button>
        </Card>
      )}
      {now.data && !now.isPending && (
        now.data.ok
          ? <Alert tone={now.data.copies.every((c) => c.ok) ? "ok" : "warn"}>Backup saved: {now.data.fileName}{now.data.copies.some((c) => !c.ok) && `. ${now.data.copies.find((c) => !c.ok)!.error}`}</Alert>
          : <Alert tone="danger">{now.data.error}</Alert>
      )}
      {now.error && <Alert tone="danger">{now.error.message}</Alert>}
      {/* Problems are in the banner above every screen; here only the advice. */}
      {s.warnings.filter((w) => w.level === "info").map((w) => (
        <Alert key={w.code} tone="warn">{w.message}</Alert>
      ))}

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 font-semibold">{s.configured ? "Where and how often" : "Set up automatic backups"}</h2>
        <p className="mb-5 text-sm text-ink-2">
          Backups are encrypted copies of everything in Ojas. Keep a second copy on a USB drive or another disk, so one failure can't take both.
        </p>
        <BackupConfigForm status={s} onSaved={refresh} />
      </Card>

      {s.configured && <RunHistory runs={runs.data} />}

      <Card className="p-4 sm:p-6">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><History aria-hidden className="size-4" /> Restore</h2>
        <p className="mb-5 text-sm text-ink-2">Bring back all data from a backup, for example after a mistake or a damaged database.</p>
        <RestorePanel
          list={api.backupFiles}
          restore={api.restore}
          defaultFolderHint="Showing backups in your backup folders"
          onRestored={() => window.location.reload()}
        />
      </Card>
    </div>
  );
}

function BackupConfigForm({ status: s, onSaved }: { status: BackupStatus; onSaved: () => void }) {
  const [form, setForm] = useState({ primaryDir: s.primaryDir, secondaryDir: s.secondaryDir, intervalHours: s.intervalHours, keepCount: String(s.keepCount) });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [changingPassword, setChangingPassword] = useState(!s.configured);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => setChangingPassword(!s.configured), [s.configured]);

  const save = useMutation({
    mutationFn: api.saveBackupConfig,
    onSuccess: () => { setPassword(""); setConfirm(""); setChangingPassword(false); setSaved(true); onSaved(); },
    onError: (e) => setErrs(formErrors(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const input = { ...form, keepCount: Number(form.keepCount), password: changingPassword ? password : undefined };
    if (changingPassword && password !== confirm) return setErrs({ confirm: "Passwords don't match" });
    const parsed = BackupConfigInput.safeParse(input);
    if (!parsed.success) return setErrs(formErrors(parsed.error));
    setErrs({});
    save.mutate(input);
  };

  const text = (k: "primaryDir" | "secondaryDir" | "keepCount") => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Main backup folder"
        value={form.primaryDir}
        onChange={text("primaryDir")}
        error={errs.primaryDir}
        placeholder={s.defaultDir}
        hint={form.primaryDir ? undefined : "Leave empty to use the folder shown (on this PC)"}
      />
      <Field
        label="Second copy (USB drive or other disk)"
        value={form.secondaryDir}
        onChange={text("secondaryDir")}
        error={errs.secondaryDir}
        placeholder="e.g. E:\OjasBackups"
        hint="Strongly recommended. Leave the drive connected, or plug it in daily."
      />
      <Select label="Back up automatically every" value={form.intervalHours} onChange={(e) => setForm((f) => ({ ...f, intervalHours: Number(e.target.value) }))}>
        {INTERVALS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? "" : "s"}</option>)}
      </Select>
      <Field label="Backups to keep in each folder" inputMode="numeric" value={form.keepCount} onChange={text("keepCount")} error={errs.keepCount} hint="Older ones are deleted automatically" />

      {changingPassword ? (
        <>
          <div className="sm:col-span-2">
            <Alert tone="warn">
              Write the backup password down and keep it away from this PC. It's needed to restore on a new PC; without it nobody, including Ojas support, can open the backups.
            </Alert>
          </div>
          <Field label={s.configured ? "New backup password" : "Backup password"} type="password" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} hint="At least 8 characters" autoComplete="new-password" />
          <Field label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errs.confirm} autoComplete="new-password" />
          {s.configured && <p className="text-sm text-ink-3 sm:col-span-2">Older backups keep their old password for restoring on another PC. On this PC they still restore without it.</p>}
        </>
      ) : (
        <div className="sm:col-span-2">
          <Button variant="ghost" onClick={() => setChangingPassword(true)}>Change backup password</Button>
        </div>
      )}

      {save.error && !Object.keys(errs).length && <div className="sm:col-span-2"><Alert tone="danger">{save.error.message}</Alert></div>}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "Checking folders…" : s.configured ? "Save" : "Turn on backups"}</Button>
        {saved && <span role="status" className="text-sm font-medium text-ok">Saved</span>}
      </div>
    </form>
  );
}

const reasonLabel: Record<BackupRun["reason"], string> = { scheduled: "Automatic", manual: "Manual", "pre-restore": "Before restore" };

function RunHistory({ runs }: { runs?: BackupRun[] }) {
  if (!runs?.length) return null;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="p-3 text-left font-semibold">Recent backups</caption>
        <thead>
          <tr className="border-y border-line text-left text-ink-3">
            <th scope="col" className="p-3 font-medium">When</th>
            <th scope="col" className="p-3 font-medium">Type</th>
            <th scope="col" className="p-3 font-medium">Result</th>
            <th scope="col" className="p-3 font-medium">Copies</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap p-3 tabular-nums">{dateTimeLabel(r.startedAt)}</td>
              <td className="p-3">{reasonLabel[r.reason]}{r.actor !== "system" && <span className="text-ink-3"> · {r.actor}</span>}</td>
              <td className="p-3">
                {r.ok ? <Badge tone="ok">Saved · {sizeLabel(r.bytes ?? 0)}</Badge> : <><Badge tone="danger">Failed</Badge> <span className="text-ink-2">{r.error}</span></>}
              </td>
              <td className="p-3">
                <span className="flex flex-col gap-0.5">
                  {r.copies.map((c, i) => (
                    <span key={c.dir} className={c.ok ? "text-ink-2" : "text-danger"} title={c.error}>
                      {i === 0 ? <HardDrive aria-hidden className="mr-1 inline size-3.5" /> : <Usb aria-hidden className="mr-1 inline size-3.5" />}
                      {c.ok ? c.dir : `${c.dir}: failed`}
                    </span>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
