import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@vistalink/api": fileURLToPath(new URL("../typescript/src/index.ts", import.meta.url)) },
  },
});
