import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderSearch, History, TriangleAlert } from "lucide-react";
import type { BackupFile, RestoreInput, RestoreResult } from "@ojas/shared";
import { ApiError, dateTimeLabel, sizeLabel } from "../../lib/api";
import { Alert, Badge, Button, Field, cx } from "../../components/ui";

const reasonLabel: Record<BackupFile["reason"], string> = { scheduled: "Automatic", manual: "Manual", "pre-restore": "Before a restore" };

/**
 * Lists backups (from the configured folders, or any folder typed in) and restores one.
 * Used on the Backups screen and, before first-run setup, for disaster recovery on a new PC.
 */
export function RestorePanel({
  list, restore, onRestored, defaultFolderHint,
}: {
  list: (folder?: string) => Promise<BackupFile[]>;
  restore: (input: RestoreInput) => Promise<RestoreResult>;
  onRestored: (r: RestoreResult) => void;
  defaultFolderHint: string;
}) {
  const [folderInput, setFolderInput] = useState("");
  const [folder, setFolder] = useState<string>();
  const files = useQuery({ queryKey: ["backup-files", folder ?? ""], queryFn: () => list(folder), retry: false });
  const [chosen, setChosen] = useState<BackupFile>();
  const folderError = files.error instanceof ApiError ? files.error.fields.folder ?? files.error.message : files.error?.message;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => { e.preventDefault(); setChosen(undefined); setFolder(folderInput.trim() || undefined); }}
      >
        <Field
          label="Look in a folder"
          className="min-w-64 flex-1"
          placeholder="e.g. E:\OjasBackups"
          value={folderInput}
          onChange={(e) => setFolderInput(e.target.value)}
          hint={folder ? `Showing ${folder}` : defaultFolderHint}
          error={folderError}
        />
        <Button type="submit" className="mt-6"><FolderSearch aria-hidden className="size-4" /> Show backups</Button>
      </form>

      {files.isLoading && <p className="text-sm text-ink-3">Looking for backups…</p>}
      {files.data && !files.data.length && <p className="text-sm text-ink-3">No Ojas backups found{folder ? ` in ${folder}` : ""}.</p>}
      {!!files.data?.length && (
        <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label="Backups found">
          {files.data.map((f) => (
            <li key={f.path} className={cx("flex flex-wrap items-center gap-3 px-3 py-2", chosen?.path === f.path && "bg-accent-soft")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">{dateTimeLabel(f.createdAt)}</span>
                  <Badge tone={f.reason === "pre-restore" ? "warn" : "neutral"}>{reasonLabel[f.reason]}</Badge>
                  {f.needsPassword && <Badge tone="accent">Needs password</Badge>}
                </div>
                <div className="truncate text-sm text-ink-3" title={f.path}>{f.facilityName || "Unnamed clinic"} · {sizeLabel(f.bytes)} · {f.path}</div>
              </div>
              <Button variant="secondary" onClick={() => setChosen(f)}><History aria-hidden className="size-4" /> Restore…</Button>
            </li>
          ))}
        </ul>
      )}

      {chosen && <ConfirmRestore key={chosen.path} file={chosen} restore={restore} onCancel={() => setChosen(undefined)} onRestored={onRestored} />}
    </div>
  );
}

function ConfirmRestore({ file, restore, onCancel, onRestored }: {
  file: BackupFile; restore: (input: RestoreInput) => Promise<RestoreResult>; onCancel: () => void; onRestored: (r: RestoreResult) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const box = useRef<HTMLFormElement>(null);
  const run = useMutation({ mutationFn: restore, onSuccess: onRestored });
  const errs = run.error instanceof ApiError ? run.error.fields : {};

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run.mutate({ path: file.path, password: password || undefined, confirm: confirm as "RESTORE" });
  };

  return (
    <form ref={box} onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-xl border-2 border-danger/40 bg-danger-soft/40 p-4" aria-labelledby="restore-title">
      <h3 id="restore-title" className="flex items-center gap-2 font-semibold text-danger">
        <TriangleAlert aria-hidden className="size-5" /> Restore the backup from {dateTimeLabel(file.createdAt)}?
      </h3>
      <ul className="list-disc pl-5 text-sm text-ink-2">
        <li>Everything in Ojas goes back to how it was at that moment. Patients, bookings and bills added since then will no longer show.</li>
        <li>A safety backup of the current data is saved first (when backups are set up), so this can be undone.</li>
        <li>Everyone on every desk is signed out and signs in again.</li>
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        {file.needsPassword && (
          <Field
            label="Backup password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errs.password}
            hint="The password set when this backup was made"
            autoComplete="off"
          />
        )}
        <Field
          label='Type RESTORE to confirm'
          autoFocus={!file.needsPassword}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value.toUpperCase())}
          error={errs.confirm}
          autoComplete="off"
        />
      </div>
      {run.error && !Object.keys(errs).length && <Alert tone="danger">{run.error.message}</Alert>}
      {run.isPending && <Alert tone="warn">Restoring… This can take up to a minute. Don't close Ojas.</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={confirm !== "RESTORE" || run.isPending}>{run.isPending ? "Restoring…" : "Restore this backup"}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={run.isPending}>Cancel</Button>
      </div>
    </form>
  );
}
