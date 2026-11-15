import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Only ever loads the LOCAL TEST env file. dotenv does not override variables
// that are already set, which is how scripts/migrate.mjs targets the live
// database without this file ever reading .env.live.local.
config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Unpooled (direct) connection: required for migrations.
    url: process.env.DATABASE_URL_UNPOOLED ?? "",
  },
});
