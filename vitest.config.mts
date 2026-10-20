import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
});
