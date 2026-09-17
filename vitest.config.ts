import { defineConfig } from "vitest/config";

// Tests assert on log output directly; keep incidental logging out of the report.
export default defineConfig({
  test: { env: { LOG_LEVEL: "error" } },
});
