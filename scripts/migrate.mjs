// Runs `drizzle-kit migrate` against the LOCAL TEST or the LIVE database.
//
//   npm run db:migrate:local
//   npm run db:migrate:live -- --confirm-live
//
// Never prints a connection string, username, password or database name.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const target = process.argv[2];

if (target !== "local" && target !== "live") {
  console.error("Usage: node scripts/migrate.mjs <local|live> [--confirm-live]");
  process.exit(1);
}

// SAFETY GATE. This must stay ABOVE any env loading or connection attempt.
// (PowerShell can swallow the `--` separator, in which case npm exposes the
// flag as npm_config_confirm_live instead of passing it as an argument.)
if (target === "live") {
  const confirmed =
    process.argv.includes("--confirm-live") ||
    process.env.npm_config_confirm_live === "true";

  if (!confirmed) {
    console.error(
      "REFUSED: db:migrate:live changes the LIVE database and needs --confirm-live.",
    );
    console.error("Nothing was loaded and no connection was attempted.");
    console.error("To proceed: npm run db:migrate:live -- --confirm-live");
    process.exit(1);
  }
}

const envFile = target === "live" ? ".env.live.local" : ".env.local";
const envKey =
  target === "live" ? "LIVE_DATABASE_URL_UNPOOLED" : "DATABASE_URL_UNPOOLED";

const loaded = {};
config({ path: envFile, processEnv: loaded, quiet: true });
const url = loaded[envKey];

if (!url) {
  console.error(`${envKey} is missing from ${envFile}.`);
  process.exit(1);
}

if (target === "live") {
  console.log("LIVE");
  console.log(new URL(url).hostname.slice(-12));
}

const drizzleKitBin = fileURLToPath(
  new URL("../node_modules/drizzle-kit/bin.cjs", import.meta.url),
);

const result = spawnSync(process.execPath, [drizzleKitBin, "migrate"], {
  stdio: "inherit",
  // drizzle.config.ts reads DATABASE_URL_UNPOOLED; set it for the child only.
  env: { ...process.env, DATABASE_URL_UNPOOLED: url },
});

process.exit(result.status ?? 1);
