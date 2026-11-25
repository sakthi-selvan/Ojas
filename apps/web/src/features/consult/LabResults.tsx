import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { isCritical } from "@ojas/shared";
import { api, dateTimeLabel } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Button, Card, cx } from "../../components/ui";
import { FlagBadge } from "../lab/ResultCard";

/** The patient's verified lab results beside the consultation, newest first; abnormal values stand out. */
export function LabResults({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const results = useQuery({ queryKey: ["lab-results", patientId], queryFn: () => api.patientLabResults(patientId), enabled: can("lab.read") });
  if (!can("lab.read") || !results.data?.length) return results.error ? <Alert tone="danger">{results.error.message}</Alert> : null;
  const shown = all ? results.data : results.data.slice(0, 3);
  return (
    <Card className="flex flex-col" aria-labelledby={`lab-${patientId}`}>
      <h2 id={`lab-${patientId}`} className="flex items-center gap-2 border-b border-line p-4 font-semibold">
        <FlaskConical aria-hidden className="size-4" /> Lab results
      </h2>
      <ol className="flex flex-col divide-y divide-line">
        {shown.map((t, i) => (
          <li key={`${t.orderId}-${i}`} className="flex flex-col gap-1 p-4 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{t.name}</span>
              <span className="ml-auto text-xs text-ink-3">{dateTimeLabel(t.verifiedAt)}</span>
            </div>
            <table className="w-full">
              <tbody>
                {t.parameters.map((p) => {
                  const r = t.results.find((x) => x.paramId === p.id);
                  if (!r) return null;
                  return (
                    <tr key={p.id} className={cx(!r.flag && "text-ink-2")}>
                      <td className="py-0.5 pr-2">{p.name}</td>
                      <td className={cx("py-0.5 pr-2 tabular-nums", r.flag && "font-semibold", isCritical(r.flag) && "text-danger")}>{r.value} <span className="text-xs font-normal text-ink-3">{p.unit}</span></td>
                      <td className="py-0.5"><FlagBadge flag={r.flag} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {t.remarks && <p className="text-xs text-ink-2">{t.remarks}</p>}
          </li>
        ))}
      </ol>
      {results.data.length > 3 && !all && <div className="p-3"><Button variant="ghost" onClick={() => setAll(true)}>Show all {results.data.length}</Button></div>}
    </Card>
  );
}
