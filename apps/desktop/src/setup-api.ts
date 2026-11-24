/** The chooser page's bridge to the main process (types shared by preload, page and main). */
import type { DiscoveryReply } from "@ojas/shared";

export interface SetupContext {
  packaged: boolean;
  reason: "first-run" | "unreachable" | "changed";
  /** Set when this PC runs the Ojas Server service. */
  server?: { serverCode: string; addresses: string[] };
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error?: string };

export interface SetupApi {
  context(): Promise<SetupContext>;
  discover(): Promise<(DiscoveryReply & { address: string; url: string })[]>;
  probe(address: string): Promise<{ ok: boolean; url: string; fingerprint?: string; serverCode?: string; name?: string; error?: string }>;
  useStandalone(): Promise<Result>;
  useClient(s: { url: string; fingerprint: string; name: string }): Promise<Result>;
  installServer(): Promise<{ ok: boolean; error?: string; serverCode?: string; addresses?: string[] }>;
  removeServer(): Promise<Result>;
  relaunch(): Promise<void>;
}
