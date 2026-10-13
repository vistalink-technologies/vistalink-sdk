/** Plain-text tables and key/value blocks for non-`--json` output. */
export type Cell = string | number | boolean | null | undefined;

const MAX_CELL = 48;

function cellText(v: Cell): string {
  if (v === null || v === undefined || v === "") return "-";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + "…" : s;
}

export function table(headers: string[], rows: Cell[][]): string {
  if (rows.length === 0) return "(none)\n";
  const text = rows.map((r) => r.map(cellText));
  const widths = headers.map((h, i) => Math.max(h.length, ...text.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers.map((h) => h.toUpperCase())), ...text.map(line)].join("\n") + "\n";
}

export function kv(pairs: Array<[string, Cell]>): string {
  const shown = pairs.filter(([, v]) => v !== undefined);
  const w = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${k.padEnd(w)}  ${v === null || v === "" ? "-" : String(v)}`).join("\n") + "\n";
}

export function money(total?: string | null, currency?: string | null): string | undefined {
  if (!total) return undefined;
  return currency ? `${total} ${currency}` : total;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
