import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, UserPlus } from "lucide-react";
import { WEEKDAY_SHORT, formatINR, type Practitioner, type Session } from "@ojas/shared";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, cx } from "../../components/ui";
import { DoctorForm } from "./DoctorForm";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const t12 = (t: string) => {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3);
  return `${h % 12 || 12}${m === "00" ? "" : `:${m}`}${h < 12 ? "am" : "pm"}`;
};

/** "Mon–Sat 9am–1pm, 5–8pm · Sun closed": days with identical hours are grouped. */
export function scheduleSummary(sessions: Session[]): string {
  if (!sessions.length) return "No consulting hours";
  const key = (d: number) => sessions.filter((s) => s.weekday === d).map((s) => `${t12(s.start)}–${t12(s.end)}`).join(", ");
  const groups: { days: number[]; hours: string }[] = [];
  for (const d of WEEK_ORDER) {
    const hours = key(d);
    const last = groups[groups.length - 1];
    if (last && last.hours === hours) last.days.push(d);
    else groups.push({ days: [d], hours });
  }
  return groups
    .filter((g) => g.hours)
    .map((g) => `${WEEKDAY_SHORT[g.days[0]!]}${g.days.length > 1 ? `–${WEEKDAY_SHORT[g.days[g.days.length - 1]!]}` : ""} ${g.hours}`)
    .join(" · ");
}

/** Doctors list with inline add / edit. Shared by the setup wizard and Settings. */
export function DoctorsPanel({ startAdding = false }: { startAdding?: boolean }) {
  const doctors = useQuery({ queryKey: ["settings-practitioners"], queryFn: api.allPractitioners });
  const [editing, setEditing] = useState<Practitioner | "new" | undefined>(startAdding ? "new" : undefined);
  const [notice, setNotice] = useState<string>();

  // Open the form straight away when there's nobody yet.
  const empty = doctors.data?.length === 0;
  const showForm = editing ?? (empty ? "new" : undefined);

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok" action={<Button variant="ghost" onClick={() => setNotice(undefined)}>Dismiss</Button>}>{notice}</Alert>}
      {doctors.error && <Alert tone="danger">{(doctors.error as Error).message}</Alert>}

      {doctors.data?.map((d) =>
        showForm !== "new" && showForm?.id === d.id ? (
          <Card key={d.id} className="p-4">
            <h3 className="mb-4 font-semibold">Edit {d.name}</h3>
            <DoctorForm doctor={d} onCancel={() => setEditing(undefined)} onSaved={(s) => { setEditing(undefined); setNotice(`${s.name} saved. New bookings use the updated fee and hours; existing bookings stay as they are.`); }} />
          </Card>
        ) : (
          <Card key={d.id} className={cx("flex flex-wrap items-center gap-3 p-4", !d.active && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{d.name}</span>
                {d.qualification && <span className="text-sm text-ink-3">{d.qualification}</span>}
                {!d.active && <Badge>Inactive</Badge>}
              </div>
              <div className="text-sm text-ink-2">{d.department} · {formatINR(d.consultationFee)} · {d.slotMinutes} min</div>
              <div className="mt-0.5 text-sm text-ink-3">{scheduleSummary(d.sessions)}</div>
            </div>
            <Button variant="secondary" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`}>
              <Pencil aria-hidden className="size-4" /> Edit
            </Button>
          </Card>
        ),
      )}

      {showForm === "new" ? (
        <Card className="p-4">
          <h3 className="mb-4 font-semibold">{empty ? "Add your first doctor" : "Add a doctor"}</h3>
          <DoctorForm
            onCancel={empty ? undefined : () => setEditing(undefined)}
            onSaved={(d) => { setEditing(undefined); setNotice(`${d.name} added.`); }}
          />
        </Card>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => { setNotice(undefined); setEditing("new"); }}>
            <UserPlus aria-hidden className="size-4" /> Add doctor
          </Button>
        </div>
      )}
    </div>
  );
}
