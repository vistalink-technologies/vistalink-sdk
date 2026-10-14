import type { FieldKind, Operation, OperationField } from "./generated/operations.js";
import { CliError } from "./exit-codes.js";

/** `max_age_hours` → `max-age-hours` (the docs' flag spelling). */
export const kebab = (s: string) => s.replace(/_/g, "-");
/** Commander's key for `--max-age-hours`: `maxAgeHours`. */
export const camel = (s: string) => s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export type ReadFile = (path: string) => string;

function parseJson(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`--${flag} expects JSON (got ${raw.length > 40 ? raw.slice(0, 40) + "…" : raw})`);
  }
}

/** `@path` → file contents, `-` → stdin (via readFile("-")), otherwise the literal. */
export function readArg(raw: string, readFile: ReadFile): string {
  if (raw === "-") return readFile("-");
  if (raw.startsWith("@")) return readFile(raw.slice(1));
  return raw;
}

/**
 * Parse one flag value the way the docs describe: scalars bare, arrays of
 * scalars comma-joined, objects and arrays of objects JSON (`@file.json` too).
 */
export function parseValue(raw: string, kind: FieldKind, flag: string, readFile: ReadFile): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "integer": {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new CliError(`--${flag} expects an integer`);
      return n;
    }
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new CliError(`--${flag} expects a number`);
      return n;
    }
    case "boolean":
      if (["true", "1", "yes"].includes(raw)) return true;
      if (["false", "0", "no"].includes(raw)) return false;
      throw new CliError(`--${flag} expects true or false`);
    case "list":
    case "list_or_json": {
      const text = readArg(raw, readFile).trim();
      if (text.startsWith("[")) return parseJson(text, flag);
      if (kind === "list_or_json" && text.startsWith("{")) return [parseJson(text, flag)];
      return text.split(",").map((s) => s.trim()).filter(Boolean);
    }
    case "string_or_json": {
      // A bare word stays a string (`--price-to-beat auto`); an object or array is JSON.
      const text = readArg(raw, readFile).trim();
      return text.startsWith("{") || text.startsWith("[") ? parseJson(text, flag) : text;
    }
    case "json":
      return parseJson(readArg(raw, readFile).trim(), flag);
  }
}

/** `--data` value: JSON literal, `@file.json`, or `-` for stdin. Must be an object. */
export function parseData(raw: string | undefined, readFile: ReadFile): Record<string, unknown> {
  if (raw === undefined) return {};
  const v = parseJson(readArg(raw, readFile), "data");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CliError("--data must be a JSON object");
  return v as Record<string, unknown>;
}

/** Body from `--data` overlaid with every per-field flag that was given. */
export function bodyFromFlags(op: Operation, opts: Record<string, unknown>, readFile: ReadFile): Record<string, unknown> {
  const body = parseData(opts.data as string | undefined, readFile);
  for (const f of op.body ?? []) {
    const raw = opts[camel(f.name)];
    if (raw === undefined) continue;
    body[f.name] = parseValue(String(raw), f.kind, kebab(f.name), readFile);
  }
  return body;
}

export function queryFromFlags(op: Operation, opts: Record<string, unknown>): Record<string, string> | undefined {
  const q: Record<string, string> = {};
  for (const f of op.query) {
    const raw = opts[camel(f.name)];
    if (raw !== undefined) q[f.name] = String(raw);
  }
  return Object.keys(q).length ? q : undefined;
}

export function missingRequired(op: Operation, body: Record<string, unknown>): OperationField[] {
  return (op.body ?? []).filter((f) => f.required && body[f.name] === undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn a bare argument into a hotel reference: a uuid stays a `hotel_id`, a
 * Booking/Expedia URL or any other URL becomes the matching identifier, and
 * anything else is a name (which needs `city`).
 */
export function hotelRef(input: string, extra: { city?: string; country?: string } = {}): string | Record<string, string> {
  const s = input.trim();
  if (UUID.test(s)) return s;
  if (s.startsWith("{")) return JSON.parse(s) as Record<string, string>;
  if (/^https?:\/\//i.test(s)) {
    let host = "";
    try {
      host = new URL(s).hostname.toLowerCase();
    } catch {
      throw new CliError(`Not a valid URL: ${s}`);
    }
    if (host === "booking.com" || host.endsWith(".booking.com")) return { booking_url: s };
    if (/(^|\.)expedia\.[a-z.]+$/.test(host)) return { expedia_url: s };
    return { website_url: s };
  }
  const id: Record<string, string> = { name: s };
  if (extra.city) id.city = extra.city;
  if (extra.country) id.country = extra.country;
  return id;
}

/** Lines of a hotels file: ids, URLs, or JSON identifier objects; `#` comments and blanks skipped. */
export function hotelsFromFile(text: string): Array<string | Record<string, string>> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => hotelRef(l));
}
