/**
 * Clinic network: one PC runs the Ojas server (as a Windows Service, HTTPS), the other desks find it
 * by UDP broadcast and pin its certificate. Staff confirm the pairing by comparing a short
 * "server code" (part of the certificate's SHA-256 fingerprint) shown on both screens.
 */

export const APP_VERSION = "0.1.0";
export const DEFAULT_PORT = 4870;
export const DISCOVERY_PORT = 4872;
/** What a desk broadcasts to find servers. */
export const DISCOVERY_PROBE = "OJAS-DISCOVER/1";

export interface DiscoveryReply {
  app: "ojas";
  v: 1;
  /** Clinic name, so staff pick the right server when there are several. */
  name: string;
  port: number;
  tls: boolean;
  /** SHA-256 of the server certificate (uppercase hex, no separators). */
  fingerprint: string;
  serverCode: string;
  version: string;
}

/** Any fingerprint spelling ("AB:CD…", "abcd…") → "ABCD…". */
export const normalizeFingerprint = (f: string): string => f.replace(/[^0-9a-f]/gi, "").toUpperCase();

/** First 64 bits of the fingerprint as 4 groups, e.g. "3F9A-12C0-88BE-41D7". Easy to read aloud. */
export const serverCode = (fingerprint: string): string =>
  normalizeFingerprint(fingerprint).slice(0, 16).match(/.{4}/g)!.join("-");

export type ServerMode = "standalone" | "server";

/** Settings → This server (administrators). */
export interface SystemInfo {
  mode: ServerMode;
  tls: boolean;
  port: number;
  hostname: string;
  /** This PC's IPv4 addresses on the network, for typing into a desk if discovery is blocked. */
  addresses: string[];
  serverCode: string | null;
  version: string;
}
