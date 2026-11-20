import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, UserPlus } from "lucide-react";
import { ROLE_LABEL, Role, type UserSummary, type Role as RoleT } from "@ojas/shared";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Alert, Badge, Button, Card, Field, cx } from "../../components/ui";

const ROLES = Role.options;

/** Readable temporary password, e.g. "tulip-4821-river". The user must replace it at first sign-in. */
function tempPassword(): string {
  const words = ["tulip", "river", "mango", "cedar", "lotus", "amber", "coral", "maple", "pearl", "tiger", "zebra", "lemon"];
  const r = crypto.getRandomValues(new Uint32Array(3));
  return `${words[r[0]! % words.length]}-${1000 + (r[1]! % 9000)}-${words[r[2]! % words.length]}`;
}

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string }>();

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateUser>[1] }) => api.updateUser(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: (e) => setNotice({ tone: "danger", text: e.message }),
  });

  const resetPassword = (u: UserSummary) => {
    const pw = tempPassword();
    update.mutate(
      { id: u.id, patch: { resetPassword: pw } },
      { onSuccess: () => setNotice({ tone: "ok", text: `Temporary password for ${u.displayName}: ${pw}. They'll choose their own at next sign-in.` }) },
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Users</h1>
        <span className="text-sm text-ink-2">Staff accounts and what each role can do</span>
        <Button variant="primary" className="ml-auto" onClick={() => setAdding(true)}>
          <UserPlus aria-hidden className="size-4" /> Add user
        </Button>
      </div>

      {notice && <Alert tone={notice.tone} action={<Button variant="ghost" onClick={() => setNotice(undefined)}>Dismiss</Button>}>{notice.text}</Alert>}
      {adding && (
        <AddUser
          onClose={() => setAdding(false)}
          onCreated={(u, pw) => {
            setAdding(false);
            setNotice({ tone: "ok", text: `${u.displayName} added. Temporary password: ${pw}. They'll choose their own at first sign-in.` });
          }}
        />
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Staff accounts</caption>
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              <th scope="col" className="p-3 font-medium">Name</th>
              <th scope="col" className="p-3 font-medium">Role</th>
              <th scope="col" className="p-3 font-medium">Status</th>
              <th scope="col" className="p-3 font-medium">Last sign-in</th>
              <th scope="col" className="p-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => {
              const self = u.id === me?.id;
              const locked = u.lockedUntil && Date.parse(u.lockedUntil) > Date.now();
              return (
                <tr key={u.id} className={cx("border-b border-line last:border-0", !u.active && "opacity-60")}>
                  <td className="p-3">
                    <div className="font-semibold">{u.displayName}{self && <span className="font-normal text-ink-3"> (you)</span>}</div>
                    <div className="text-ink-2">{u.username}</div>
                  </td>
                  <td className="p-3">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>Role for {u.displayName}</label>
                    <select
                      id={`role-${u.id}`}
                      value={u.role}
                      disabled={self || update.isPending}
                      onChange={(e) => update.mutate({ id: u.id, patch: { role: e.target.value as RoleT } })}
                      className="min-h-9 rounded-md border border-line bg-surface px-2 text-ink"
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {u.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}
                      {locked && <Badge tone="danger">Locked</Badge>}
                      {u.mustChangePassword && <Badge tone="warn">Temp password</Badge>}
                      {u.hasPin && <Badge tone="accent">PIN</Badge>}
                    </div>
                  </td>
                  <td className="p-3 text-ink-2">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Never"}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => resetPassword(u)} disabled={update.isPending} aria-label={`Reset password for ${u.displayName}`}>
                        <KeyRound aria-hidden className="size-3.5" /> Reset password
                      </Button>
                      {u.hasPin && (
                        <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => update.mutate({ id: u.id, patch: { clearPin: true } })} aria-label={`Clear PIN for ${u.displayName}`}>
                          Clear PIN
                        </Button>
                      )}
                      {!self && (
                        <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => update.mutate({ id: u.id, patch: { active: !u.active } })} aria-label={`${u.active ? "Deactivate" : "Reactivate"} ${u.displayName}`}>
                          {u.active ? "Deactivate" : "Reactivate"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {users.error && <div className="p-3"><Alert tone="danger">{(users.error as Error).message}</Alert></div>}
      </Card>

      <RoleGuide />
    </div>
  );
}

function AddUser({ onClose, onCreated }: { onClose: () => void; onCreated: (u: UserSummary, password: string) => void }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<RoleT>("RECEPTION");
  const [password] = useState(tempPassword);
  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      onCreated(u, password);
    },
  });
  const errs = create.error instanceof ApiError ? create.error.fields : {};
  // Suggest a username from the name: "Priya Sharma" → "priya.sharma".
  const suggest = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 32);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ displayName, username, role, password });
  };

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[2fr_2fr_1.5fr_auto]" aria-label="Add user" noValidate>
        <Field
          label="Full name"
          autoFocus
          value={displayName}
          onChange={(e) => {
            if (!username || username === suggest(displayName)) setUsername(suggest(e.target.value));
            setDisplayName(e.target.value);
          }}
          error={errs.displayName}
        />
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} error={errs.username} autoCapitalize="none" spellCheck={false} />
        <div className="flex flex-col gap-1">
          <label htmlFor="new-role" className="text-sm font-medium text-ink-2">Role</label>
          <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as RoleT)} className="min-h-11 rounded-lg border border-line bg-surface px-3 text-base text-ink">
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>{create.isPending ? "Adding…" : "Add"}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
        {create.error && !Object.keys(errs).length && <div className="sm:col-span-4"><Alert tone="danger">{create.error.message}</Alert></div>}
      </form>
    </Card>
  );
}

const GUIDE: Record<RoleT, string> = {
  ADMIN: "Everything, including users and audit checks",
  RECEPTION: "Register patients, book, collect payment, manage the queue",
  ACCOUNTS: "Collect payments and give discounts",
  DOCTOR: "See patients and the queue, call patients in",
  NURSE: "See patients and the queue, check patients in",
  LAB: "See patients (lab module coming)",
  PHARMACY: "See patients (pharmacy module coming)",
};

function RoleGuide() {
  return (
    <details className="rounded-xl border border-line bg-surface p-4 text-sm">
      <summary className="cursor-pointer font-semibold">What can each role do?</summary>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {ROLES.map((r) => (
          <div key={r}>
            <dt className="font-medium">{ROLE_LABEL[r]}</dt>
            <dd className="text-ink-2">{GUIDE[r]}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
