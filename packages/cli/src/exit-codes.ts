import { VistaLinkError } from "@vistalink/api";

/**
 * Process exit codes. Stable: scripts may branch on them.
 * 0 ok · 1 unexpected · 2 usage / bad_request · 3 unauthorized · 4 forbidden
 * · 5 not_found · 6 conflict · 7 rate_limited · 8 insufficient_credit
 * · 9 upstream_error · 10 unavailable · 11 not_implemented · 12 network_error
 * · 13 timeout · 14 job_failed · 15 job_canceled
 */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  bad_request: 2,
  unauthorized: 3,
  forbidden: 4,
  not_found: 5,
  conflict: 6,
  rate_limited: 7,
  insufficient_credit: 8,
  upstream_error: 9,
  unavailable: 10,
  not_implemented: 11,
  network_error: 12,
  timeout: 13,
  job_failed: 14,
  job_canceled: 15,
} as const;

export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.exitCode;
  if (err instanceof VistaLinkError) return (EXIT as Record<string, number>)[err.code] ?? EXIT.unexpected;
  return EXIT.unexpected;
}

/** A user-facing error raised by the CLI itself (bad flags, missing key, …). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.usage,
    readonly code: string = "usage",
  ) {
    super(message);
    this.name = "CliError";
  }
}
