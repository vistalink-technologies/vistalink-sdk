#!/usr/bin/env node
// Rebuild test/fixtures/docs-cli-samples.json: the CLI sample the vistalink.com
// docs print for every operation (lib/api-docs-text.ts cliSample, ported),
// as argv arrays plus the request the docs expect it to send.
//   node scripts/docs-samples.mjs path/to/vistalink.com/content/openapi.v2.json [source-label] [out.json]
// Path and query parameters render only when the spec marks them
// `x-vistalink-render-default` (paramExample() in lib/api-docs-text.ts);
// headers use their example. With the generated spec (../../spec/openapi.v2.json) and
// test/fixtures/spec-cli-samples.json as out, it builds the same samples from
// the spec's own examples, i.e. what the docs will print once the site serves it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [specPath, source = specPath, outPath = resolve(here, "../test/fixtures/docs-cli-samples.json")] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const ptr = (ref) => ref.split("/").slice(1).reduce((o, k) => o[k], spec);
const paramExample = (_opId, p) =>
  p.in === "header" ? p.example : p["x-vistalink-render-default"] === true ? p.example : undefined;

// orderLike() in lib/api-content.ts: body keys in schema property order.
function orderLike(value, schema) {
  if (!schema) return value;
  const s = schema.$ref ? ptr(schema.$ref) : schema;
  if (Array.isArray(value)) {
    const item = s.items ?? (s.anyOf ?? s.oneOf)?.find((a) => a.type === "array")?.items;
    return value.map((v) => orderLike(v, item));
  }
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  const candidates = [s, ...(s.anyOf ?? []), ...(s.oneOf ?? [])].map((c) => (c.$ref ? ptr(c.$ref) : c)).filter((c) => c.properties);
  const target = candidates.find((c) => keys.every((k) => k in c.properties)) ?? candidates[0];
  if (!target?.properties) return value;
  const order = Object.keys(target.properties);
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.fromEntries([...keys].sort((x, y) => rank(x) - rank(y)).map((k) => [k, orderLike(value[k], target.properties[k])]));
}
const kebab = (s) => s.replace(/_/g, "-");

// Same rules as cliValue() in api-docs-text.ts, without the shell quoting.
function cliValue(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return v.join(",");
  return JSON.stringify(v);
}

const samples = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, raw] of Object.entries(item)) {
    if (!raw["x-vistalink-cli"]) continue;
    const params = (raw.parameters ?? []).map((p) => (p.$ref ? ptr(p.$ref) : p));
    const argv = raw["x-vistalink-cli"].replace(/^vistalink /, "").split(" ");
    const pathValues = {};
    for (const p of params.filter((x) => x.in === "path")) {
      const v = String(paramExample(raw.operationId, p) ?? `<${p.name}>`);
      argv.push(v);
      pathValues[p.name] = v;
    }
    const query = {};
    let idempotencyKey;
    for (const p of params) {
      const ex = paramExample(raw.operationId, p);
      if (p.in === "query" && ex !== undefined) {
        argv.push(`--${kebab(p.name)}`, cliValue(ex));
        query[p.name] = String(ex);
      }
      if (p.in === "header" && p.name === "Idempotency-Key" && ex !== undefined) {
        argv.push("--idempotency-key", cliValue(ex));
        idempotencyKey = String(ex);
      }
    }
    const media = raw.requestBody?.content?.["application/json"];
    // The site's content layer reads media-type examples. The generated spec
    // (the API spec) carries them on the component schema instead
    // (`examples[0]`), so fall back to that.
    const schema = media?.schema?.$ref ? ptr(media.schema.$ref) : media?.schema;
    const example = media?.examples
      ? Object.values(media.examples)[0]?.value
      : (media?.example ?? schema?.examples?.[0] ?? schema?.example);
    const body = example && typeof example === "object" ? {} : undefined;
    if (body) {
      for (const [k, v] of Object.entries(orderLike(example, media.schema))) {
        if (v === null || v === undefined) continue;
        argv.push(`--${kebab(k)}`, cliValue(v));
        body[k] = v;
      }
    }
    samples.push({ key: `${method.toUpperCase()} ${path}`, cli: raw["x-vistalink-cli"], argv, path: pathValues, query, body, idempotencyKey });
  }
}
writeFileSync(resolve(outPath), JSON.stringify({ source, samples }, null, 2) + "\n");
console.log(`${samples.length} docs CLI samples written`);
