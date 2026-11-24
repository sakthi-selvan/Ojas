/** Script for setup.html (bundled to dist/setup.js). Talks to the main process only through window.ojasSetup. */
import type { SetupApi, SetupContext } from "./setup-api";

declare global {
  interface Window { ojasSetup: SetupApi }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const api = window.ojasSetup;
const sections = ["choose", "client", "confirm", "server", "server-done"];
let pending: { url: string; fingerprint: string; name: string } | undefined;

function show(id: string) {
  for (const s of sections) $(s).hidden = s !== id;
  $("error").hidden = true;
  $(id).querySelector<HTMLElement>("button.primary, input, button")?.focus();
}
function fail(el: string, msg: string) {
  $(el).textContent = msg;
  $(el).hidden = false;
}

async function search() {
  $("search-status").textContent = "Looking on the network…";
  $("found").replaceChildren();
  const found = await api.discover();
  $("search-status").textContent = found.length
    ? `Found ${found.length} Ojas server${found.length === 1 ? "" : "s"}:`
    : "No server answered. It may be switched off, or the network blocks searching: type its address below.";
  for (const s of found) {
    const row = document.createElement("div");
    row.className = "server";
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = s.name || "Ojas server (setup not finished)";
    const small = document.createElement("div");
    small.className = "small";
    small.textContent = `${s.address} · code ${s.serverCode}`;
    text.append(strong, small);
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "Use this server";
    btn.onclick = () => void choose(s.url);
    row.append(text, btn);
    $("found").append(row);
  }
}

async function choose(address: string) {
  $("client-error").hidden = true;
  const p = await api.probe(address);
  if (!p.ok) return fail("client-error", `Couldn't connect to ${p.url}: ${p.error}`);
  pending = { url: p.url, fingerprint: p.fingerprint!, name: p.name ?? "" };
  $("confirm-name").textContent = p.name || "an Ojas server";
  $("confirm-url").textContent = p.url;
  $("confirm-code").textContent = p.serverCode!;
  show("confirm");
}

function showServerDone(info: { serverCode: string; addresses: string[] }, removable: boolean) {
  $("done-code").textContent = info.serverCode;
  $("done-addresses").textContent = info.addresses.length ? `This PC's address on the network: ${info.addresses.join(", ")}` : "";
  $("remove-server").hidden = !removable;
  show("server-done");
}

async function init() {
  const ctx: SetupContext = await api.context();
  if (ctx.reason === "unreachable") $("subtitle").textContent = "Couldn't reach the clinic's server. Find it again, or change how this PC is used.";
  if (ctx.server) {
    $("subtitle").textContent = "This PC runs the clinic's Ojas server.";
    showServerDone(ctx.server, ctx.packaged);
  } else if (ctx.reason === "unreachable") {
    show("client");
    void search();
  } else {
    show("choose");
  }
  if (!ctx.packaged) {
    ($("pick-server") as HTMLButtonElement).disabled = true;
    $("pick-server").title = "Only in the installed app";
  }
}

$("pick-standalone").onclick = async () => {
  const r = await api.useStandalone();
  if (!r.ok) fail("error", r.error ?? "Couldn't save");
};
$("pick-client").onclick = () => { show("client"); void search(); };
$("pick-server").onclick = () => show("server");
$("search-again").onclick = () => void search();
$<HTMLFormElement>("manual").onsubmit = (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>("addr").value.trim();
  if (v) void choose(v);
};
$("confirm-yes").onclick = async () => {
  if (!pending) return;
  const r = await api.useClient(pending);
  if (!r.ok) { show("client"); fail("client-error", r.error ?? "Couldn't connect"); }
};
$("confirm-no").onclick = () => {
  pending = undefined;
  show("client");
  fail("client-error", "Don't connect: tell the clinic's administrator. Check you picked the right server, or that someone hasn't set up a fake one.");
};
$("install-server").onclick = async () => {
  const btn = $<HTMLButtonElement>("install-server");
  btn.disabled = true;
  $("server-error").hidden = true;
  $("server-progress").hidden = false;
  const r = await api.installServer();
  $("server-progress").hidden = true;
  btn.disabled = false;
  if (!r.ok) return fail("server-error", r.error ?? "Installation failed");
  showServerDone({ serverCode: r.serverCode!, addresses: r.addresses ?? [] }, false);
};
$("open").onclick = () => void api.relaunch();
$("remove-server").onclick = async () => {
  if (!confirm("Remove the Ojas Server service from this PC? Desks will lose their connection. The data stays on this PC.")) return;
  const r = await api.removeServer();
  if (!r.ok) return fail("remove-error", r.error ?? "Couldn't remove the server");
  $("subtitle").textContent = "The server was removed. How will this computer be used now?";
  show("choose");
};
document.querySelectorAll<HTMLButtonElement>("[data-back]").forEach((b) => (b.onclick = () => show("choose")));

void init();
