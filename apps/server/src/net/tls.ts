/**
 * The server's own HTTPS certificate, made on first start in server mode. It is self-signed:
 * desks don't rely on a certificate authority, they pin this certificate's fingerprint when they
 * pair (after staff compare the server code). Valid for 10 years; delete the folder to make a new
 * one, after which every desk must pair again.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { normalizeFingerprint, serverCode } from "@ojas/shared";

export interface ServerCertificate {
  key: string;
  cert: string;
  fingerprint: string;
  serverCode: string;
}

export function fingerprintOf(certPem: string): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes();
  return normalizeFingerprint(createHash("sha256").update(Buffer.from(der, "binary")).digest("hex"));
}

export function ensureCertificate(dir: string, opts: { restrictKey?: boolean } = {}): ServerCertificate {
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
    cert.serialNumber = `01${randomBytes(15).toString("hex")}`; // positive, 16 bytes
    const now = new Date();
    cert.validity.notBefore = new Date(now.getTime() - 24 * 3_600_000);
    cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
    const host = hostname();
    const subject = [{ name: "commonName", value: `Ojas server ${host}`.slice(0, 64) }, { name: "organizationName", value: "Ojas" }];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: host },
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ]);
    cert.sign(forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
    writeFileSync(keyFile, privateKey, { mode: 0o600 });
    writeFileSync(certFile, forge.pki.certificateToPem(cert));
    // On Windows, file modes don't apply: limit the private key to SYSTEM and Administrators.
    if (opts.restrictKey && process.platform === "win32") {
      try {
        execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"], { stdio: "ignore" });
      } catch {
        /* best effort: logged by the caller's startup checks */
      }
    }
  }
  const key = readFileSync(keyFile, "utf8");
  const cert = readFileSync(certFile, "utf8");
  const fingerprint = fingerprintOf(cert);
  return { key, cert, fingerprint, serverCode: serverCode(fingerprint) };
}
