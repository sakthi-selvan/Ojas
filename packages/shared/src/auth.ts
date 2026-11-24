/**
 * Who can do what. One table shared by the server (enforcement) and the UI (hiding what a person
 * cannot use). The server is always the authority; the UI hiding something is only a convenience.
 */
import { z } from "zod";

export const Role = z.enum(["ADMIN", "RECEPTION", "ACCOUNTS", "DOCTOR", "NURSE", "LAB", "PHARMACY"]);
export type Role = z.infer<typeof Role>;

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrator",
  RECEPTION: "Reception",
  ACCOUNTS: "Accounts",
  DOCTOR: "Doctor",
  NURSE: "Nurse",
  LAB: "Laboratory",
  PHARMACY: "Pharmacy",
};

export const PERMISSIONS = [
  "patients.read",
  "patients.write",
  "appointments.book",
  "billing.collect",
  "billing.discount",
  "queue.update",
  "consult.read",
  "consult.write",
  "vitals.write",
  "pharmacy.sell",
  "pharmacy.purchase",
  "pharmacy.stock",
  "pharmacy.reports",
  "users.manage",
  "settings.manage",
  "audit.verify",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  RECEPTION: ["patients.read", "patients.write", "appointments.book", "billing.collect", "queue.update"],
  ACCOUNTS: ["patients.read", "billing.collect", "billing.discount", "pharmacy.reports"],
  DOCTOR: ["patients.read", "queue.update", "consult.read", "consult.write", "vitals.write"],
  NURSE: ["patients.read", "queue.update", "consult.read", "vitals.write"],
  LAB: ["patients.read"],
  PHARMACY: ["patients.read", "billing.discount", "pharmacy.sell", "pharmacy.purchase", "pharmacy.stock", "pharmacy.reports"],
};

export const can = (role: Role | undefined, perm: Permission): boolean => !!role && ROLE_PERMISSIONS[role].includes(perm);

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  hasPin: boolean;
  mustChangePassword: boolean;
}

export interface AuthStatus {
  /** True on a brand-new install: the first screen creates the administrator. */
  needsSetup: boolean;
  user: SessionUser | null;
}

// ───────────────────────── Inputs ─────────────────────────

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "3–32 characters: letters, numbers, dot, dash or underscore");

export const Password = z.string().min(8, "Use at least 8 characters").max(128);

const WEAK_PINS = new Set(["0000", "1111", "1234", "4321", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1212", "123456", "000000", "111111", "654321"]);
export const Pin = z
  .string()
  .regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits")
  .refine((p) => !WEAK_PINS.has(p), "That PIN is too easy to guess");

export const DisplayName = z.string().trim().min(2, "Enter a name").max(80);

export const LoginInput = z.object({ username: Username, password: z.string().min(1, "Enter your password").max(128) });
export type LoginInput = z.input<typeof LoginInput>;

export const PinLoginInput = z.object({ userId: z.uuid(), pin: z.string().regex(/^\d{4,6}$/, "Enter your PIN") });
export type PinLoginInput = z.input<typeof PinLoginInput>;

export const SetupInput = z.object({ displayName: DisplayName, username: Username, password: Password, pin: Pin.optional() });
export type SetupInput = z.input<typeof SetupInput>;

export const CreateUserInput = z.object({ displayName: DisplayName, username: Username, role: Role, password: Password });
export type CreateUserInput = z.input<typeof CreateUserInput>;

export const UpdateUserInput = z.object({
  displayName: DisplayName.optional(),
  role: Role.optional(),
  active: z.boolean().optional(),
  /** Admin sets a temporary password; the user must change it at next sign-in. */
  resetPassword: Password.optional(),
  clearPin: z.boolean().optional(),
});
export type UpdateUserInput = z.input<typeof UpdateUserInput>;

export const ChangeCredentialsInput = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(128),
  newPassword: Password.optional(),
  newPin: Pin.optional(),
});
export type ChangeCredentialsInput = z.input<typeof ChangeCredentialsInput>;

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  hasPin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
}

/** Minimal public profile for the lock screen's "who are you?" tiles. */
export interface UserTile {
  id: string;
  displayName: string;
  role: Role;
  hasPin: boolean;
}
