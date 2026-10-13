// The unscoped `vistalink` package only forwards to @vistalink/cli. Check that
// the pointer resolves, runs the real CLI, and stays in version step with it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here("../package.json"), "utf8"));
const require = createRequire(import.meta.url);
const cliPkg = JSON.parse(readFileSync(require.resolve("@vistalink/cli/package.json"), "utf8"));

assert.equal(pkg.name, "vistalink");
assert.equal(pkg.bin.vistalink, "./bin/vistalink.js");
assert.equal(pkg.version, cliPkg.version, "vistalink and @vistalink/cli must ship the same version");
assert.ok(pkg.dependencies["@vistalink/cli"], "depends on @vistalink/cli");
assert.match(readFileSync(here("../README.md"), "utf8"), /@vistalink\/cli/);

const out = execFileSync(process.execPath, [here("../bin/vistalink.js"), "--version"], { encoding: "utf8" }).trim();
assert.equal(out, cliPkg.version, "bin/vistalink.js runs @vistalink/cli");
console.log(`ok: vistalink ${pkg.version} -> @vistalink/cli ${cliPkg.version} (--version printed ${out})`);
