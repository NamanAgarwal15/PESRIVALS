import { config } from "dotenv";

// Tests only ever use the LOCAL TEST database. `override` makes sure a
// DATABASE_URL that happens to be set in the shell can never win.
// .env.live.local and .env.vercel.local are never loaded.
config({ path: ".env.local", override: true, quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env.local; cannot run tests.");
}
