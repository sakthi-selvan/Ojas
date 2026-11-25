import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { DISCHARGE_TYPE_LABEL } from "@ojas/shared";
import { api, dateTimeLabel } from "../../lib/api";
import { Alert, Badge, Card } from "../../components/ui";

/** Who went home in the last 30 days, or any past admission by name, UHID, phone or IP number. */
export function DischargedList({ onOpen }: { onOpen: (id: string) => void }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useQuery({ queryKey: ["ipd-admissions", "DISCHARGED", q], queryFn: () => api.admissions("DISCHARGED", q), placeholderData: keepPreviousData });
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <Search aria-hidden className="size-4 text-ink-3" />
        <input
          aria-label="Find a past admission"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, UHID, phone or IP number"
          className="min-h-10 flex-1 rounded-lg border border-line bg-surface px-3"
        />
      </div>
      {list.error && <div className="p-3"><Alert tone="danger">{list.error.message}</Alert></div>}
      {list.data && !list.data.length && <p className="p-4 text-ink-3">{q ? "No admissions match." : "No one discharged in the last 30 days."}</p>}
      <ul className="divide-y divide-line">
        {list.data?.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 p-3 text-left hover:bg-surface-2">
              <span className="min-w-48 flex-1">
                <span className="block font-semibold">{a.patient.name} <span className="font-normal text-ink-3">· {a.patient.uhid}</span></span>
                <span className="block text-sm text-ink-2">{a.admissionNo} · {a.doctorName} · {a.wardName}</span>
              </span>
              <span className="text-sm text-ink-2">{dateTimeLabel(a.admittedAt)} → {a.dischargedAt ? dateTimeLabel(a.dischargedAt) : "—"}</span>
              {a.dischargeType && a.dischargeType !== "NORMAL" && <Badge tone="warn">{DISCHARGE_TYPE_LABEL[a.dischargeType]}</Badge>}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
