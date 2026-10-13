import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: false, // no maps in the published tarball (they would point at unpublished src/)
  clean: true,
  target: "es2022",
  platform: "neutral",
  // openapi-fetch is a runtime dep; everything else is bundled-free (no node built-ins).
  external: ["openapi-fetch"],
});
