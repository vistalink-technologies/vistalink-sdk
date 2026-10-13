import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false, // no maps in the published tarball (they would point at unpublished src/)
  dts: { entry: { index: "src/index.ts" } },
  // Bundle the SDK so the published CLI has one runtime dependency (commander).
  noExternal: ["@vistalink/api", "openapi-fetch"],
});
