import { useQuery } from "@tanstack/react-query";
import { DatabaseBackup } from "lucide-react";
import { api } from "../../lib/api";
import { Button, cx } from "../../components/ui";

/**
 * Shown to administrators on every screen when backups are off, failing, or out of date: the one
 * problem nobody notices until the day the disk dies.
 */
export function BackupBanner({ onOpen }: { onOpen: () => void }) {
  const status = useQuery({ queryKey: ["backup-status"], queryFn: api.backupStatus, refetchInterval: 5 * 60_000, retry: false });
  const shown = status.data?.warnings.filter((w) => w.level !== "info") ?? [];
  if (!shown.length) return null;
  const danger = shown.some((w) => w.level === "danger");
  return (
    <div
      role={danger ? "alert" : "status"}
      className={cx("flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm font-medium lg:px-6", danger ? "border-danger/30 bg-danger-soft text-danger" : "border-warn/30 bg-warn-soft text-warn")}
    >
      <DatabaseBackup aria-hidden className="size-4 shrink-0" />
      <span className="flex-1">{shown[0]!.message}</span>
      <Button variant="secondary" className="min-h-8" onClick={onOpen}>Open backups</Button>
    </div>
  );
}
