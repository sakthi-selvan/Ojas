import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Plane, Trash2 } from "lucide-react";
import { HolidayInput, LeaveInput } from "@ojas/shared";
import { api, dateLabel, today } from "../../lib/api";
import { Alert, Button, Card, Field, Select } from "../../components/ui";
import { formErrors } from "./forms";

type Notice = { tone: "ok" | "warn"; text: string };
const bookedNotice = (n: number, what: string): Notice =>
  n > 0
    ? { tone: "warn", text: `${what} ${n} patient${n === 1 ? " is" : "s are"} already booked then. Please call them to rebook.` }
    : { tone: "ok", text: `${what} No existing bookings are affected.` };

/** Clinic holidays (everyone off) and individual doctors' leave. Both block booking on those days. */
export function HolidaysPanel() {
  const [notice, setNotice] = useState<Notice>();
  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone={notice.tone} action={<Button variant="ghost" onClick={() => setNotice(undefined)}>Dismiss</Button>}>{notice.text}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Holidays onNotice={setNotice} />
        <Leaves onNotice={setNotice} />
      </div>
    </div>
  );
}

function useRefreshSlots() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["slots"] });
}

function Holidays({ onNotice }: { onNotice: (n: Notice) => void }) {
  const qc = useQueryClient();
  const refreshSlots = useRefreshSlots();
  const list = useQuery({ queryKey: ["holidays"], queryFn: api.holidays });
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});

  const add = useMutation({
    mutationFn: api.addHoliday,
    onSuccess: (r) => {
      setDate(""); setName(""); setErrs({});
      void qc.invalidateQueries({ queryKey: ["holidays"] });
      refreshSlots();
      onNotice(bookedNotice(r.bookedPatients, `${r.holiday.name} (${dateLabel(r.holiday.date)}) added.`));
    },
    onError: (e) => setErrs(formErrors(e)),
  });
  const remove = useMutation({
    mutationFn: api.deleteHoliday,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["holidays"] }); refreshSlots(); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = HolidayInput.safeParse({ date, name });
    if (!parsed.success) return setErrs(formErrors(parsed.error));
    add.mutate({ date, name });
  };

  const upcoming = list.data?.filter((h) => h.date >= today()) ?? [];
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><CalendarOff aria-hidden className="size-4" /> Clinic holidays</h2>
        <p className="text-sm text-ink-2">The whole clinic is closed. No appointments can be booked.</p>
      </div>
      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-start">
        <Field label="Date" type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} error={errs.date} />
        <Field label="Occasion" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} placeholder="e.g. Pongal" />
        <Button type="submit" variant="primary" className="sm:mt-6" disabled={add.isPending}>Add</Button>
      </form>
      {add.error && !Object.keys(errs).length && <Alert tone="danger">{add.error.message}</Alert>}
      <ul className="flex flex-col divide-y divide-line">
        {upcoming.map((h) => (
          <li key={h.date} className="flex items-center gap-3 py-2">
            <span className="w-36 shrink-0 text-sm tabular-nums">{dateLabel(h.date)}</span>
            <span className="flex-1 font-medium">{h.name}</span>
            <Button variant="ghost" onClick={() => remove.mutate(h.date)} aria-label={`Remove holiday ${h.name}`}><Trash2 aria-hidden className="size-4" /></Button>
          </li>
        ))}
        {list.data && !upcoming.length && <li className="py-2 text-sm text-ink-3">No upcoming holidays.</li>}
      </ul>
    </Card>
  );
}

function Leaves({ onNotice }: { onNotice: (n: Notice) => void }) {
  const qc = useQueryClient();
  const refreshSlots = useRefreshSlots();
  const doctors = useQuery({ queryKey: ["settings-practitioners"], queryFn: api.allPractitioners });
  const list = useQuery({ queryKey: ["leaves"], queryFn: api.leaves });
  const [form, setForm] = useState({ practitionerId: "", fromDate: "", toDate: "", reason: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value;
    // Picking a start date fills the end date: most leave is a single day.
    setForm((f) => ({ ...f, [k]: v, ...(k === "fromDate" && (!f.toDate || f.toDate < v) ? { toDate: v } : {}) }));
  };

  const add = useMutation({
    mutationFn: api.addLeave,
    onSuccess: (r) => {
      setForm((f) => ({ ...f, fromDate: "", toDate: "", reason: "" })); setErrs({});
      void qc.invalidateQueries({ queryKey: ["leaves"] });
      refreshSlots();
      const range = r.leave.fromDate === r.leave.toDate ? dateLabel(r.leave.fromDate) : `${dateLabel(r.leave.fromDate)} to ${dateLabel(r.leave.toDate)}`;
      onNotice(bookedNotice(r.bookedPatients, `Leave for ${r.leave.practitionerName} on ${range} added.`));
    },
    onError: (e) => setErrs(formErrors(e)),
  });
  const remove = useMutation({
    mutationFn: api.deleteLeave,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["leaves"] }); refreshSlots(); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.practitionerId) return setErrs({ practitionerId: "Choose a doctor" });
    const parsed = LeaveInput.safeParse(form);
    if (!parsed.success) return setErrs(formErrors(parsed.error));
    add.mutate(form);
  };

  const current = list.data?.filter((l) => l.toDate >= today()) ?? [];
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><Plane aria-hidden className="size-4" /> Doctor leave</h2>
        <p className="text-sm text-ink-2">Only this doctor is unavailable. The front desk is told when they're back.</p>
      </div>
      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
        <Select label="Doctor" className="sm:col-span-2" value={form.practitionerId} onChange={set("practitionerId")} error={errs.practitionerId}>
          <option value="">Choose a doctor…</option>
          {doctors.data?.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name} · {d.department}</option>)}
        </Select>
        <Field label="From" type="date" min={today()} value={form.fromDate} onChange={set("fromDate")} error={errs.fromDate} />
        <Field label="To" type="date" min={form.fromDate || today()} value={form.toDate} onChange={set("toDate")} error={errs.toDate} />
        <Field label="Reason (optional)" className="sm:col-span-2" value={form.reason} onChange={set("reason")} error={errs.reason} placeholder="e.g. Conference" hint="Shown to the front desk" />
        <div className="sm:col-span-2"><Button type="submit" variant="primary" disabled={add.isPending}>Add leave</Button></div>
      </form>
      {add.error && !Object.keys(errs).length && <Alert tone="danger">{add.error.message}</Alert>}
      <ul className="flex flex-col divide-y divide-line">
        {current.map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{l.practitionerName}</div>
              <div className="text-sm text-ink-2">
                {l.fromDate === l.toDate ? dateLabel(l.fromDate) : `${dateLabel(l.fromDate)} – ${dateLabel(l.toDate)}`}
                {l.reason && ` · ${l.reason}`}
              </div>
            </div>
            <Button variant="ghost" onClick={() => remove.mutate(l.id)} aria-label={`Remove leave for ${l.practitionerName}`}><Trash2 aria-hidden className="size-4" /></Button>
          </li>
        ))}
        {list.data && !current.length && <li className="py-2 text-sm text-ink-3">No upcoming leave.</li>}
      </ul>
    </Card>
  );
}
