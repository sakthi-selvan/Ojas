/** Errors with a stable machine code and a message written for the receptionist, not the developer. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const isUniqueViolation = (e: unknown, constraint?: string): boolean => {
  const err = e as { code?: string; constraint?: string; message?: string };
  if (err?.code !== "23505") return false;
  return !constraint || err.constraint === constraint || (err.message ?? "").includes(constraint);
};
