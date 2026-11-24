import { useQuery } from "@tanstack/react-query";
import { Monitor, Server, ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { Alert, Card } from "../../components/ui";

/** Settings → This server: how desks connect, and the code they must match when pairing. */
export function ThisServerPanel() {
  const info = useQuery({ queryKey: ["system-info"], queryFn: api.systemInfo });
  if (info.error) return <Alert tone="danger">{info.error.message}</Alert>;
  if (!info.data) return <p className="text-sm text-ink-3">Loading…</p>;
  const s = info.data;

  if (s.mode !== "server") {
    return (
      <Card className="flex flex-col gap-3 p-4 sm:p-6">
        <h2 className="flex items-center gap-2 font-semibold"><Monitor aria-hidden className="size-4" /> This PC only</h2>
        <p className="text-sm text-ink-2">
          Ojas runs on this computer alone; other PCs can't connect. To add more desks, make one PC the clinic's server: in the Ojas app,
          open your name (top right) → <strong>This PC's connection</strong> → <strong>Main server for the clinic</strong>. This PC's data moves with it.
        </p>
        <p className="text-sm text-ink-3">Version {s.version} · {s.hostname}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-4 sm:p-6">
        <h2 className="flex items-center gap-2 font-semibold"><Server aria-hidden className="size-4" /> This PC is the clinic's server</h2>
        <div>
          <div className="text-sm font-medium text-ink-2">Server code</div>
          <div className="mt-1 inline-block rounded-lg bg-surface-2 px-4 py-2 font-mono text-2xl font-semibold tracking-wider" aria-label={`Server code ${s.serverCode?.split("").join(" ")}`}>
            {s.serverCode}
          </div>
          <p className="mt-2 flex items-start gap-2 text-sm text-ink-2">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
            When a desk connects for the first time it shows a code. It must match this one; that proves the desk is talking to this server and nobody else.
          </p>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-ink-3">PC name</dt><dd className="font-medium">{s.hostname}</dd>
          <dt className="text-ink-3">Address{s.addresses.length === 1 ? "" : "es"}</dt>
          <dd className="font-medium tabular-nums">{s.addresses.length ? s.addresses.map((a) => `${a}:${s.port}`).join(", ") : "Not connected to a network"}</dd>
          <dt className="text-ink-3">Connection</dt><dd>{s.tls ? "Encrypted (HTTPS)" : "Not encrypted"}</dd>
          <dt className="text-ink-3">Version</dt><dd>{s.version}</dd>
        </dl>
      </Card>
      <Card className="flex flex-col gap-2 p-4 sm:p-6">
        <h2 className="font-semibold">Adding a desk</h2>
        <ol className="list-decimal pl-5 text-sm text-ink-2">
          <li>Install Ojas on the desk PC and open it.</li>
          <li>Choose <strong>A desk on the clinic network</strong>. This server appears in the list; if it doesn't, type {s.addresses[0] ?? s.hostname}.</li>
          <li>Check the code on the desk matches the server code above, then connect.</li>
        </ol>
        <p className="text-sm text-ink-3">Keep this PC switched on during clinic hours. If its address changes, desks find it again automatically.</p>
      </Card>
    </div>
  );
}
