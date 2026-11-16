import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests hit the LOCAL TEST database and hash with bcrypt cost 12.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
