// Idempotent LIVE account recovery setup for @naman (admin + recovery
// channels + temporary password) and @ayush (phone only).
//
//   node scripts/setup-live-accounts.mjs --confirm-live
//
// SAFETY: reads LIVE_DATABASE_URL from .env.live.local only, refuses without
// --confirm-live, refuses to run against the LOCAL test database, never
// touches matches, and prints no secrets, hashes or connection strings.

import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { neon } from "@neondatabase/serverless";

if (
  !process.argv.includes("--confirm-live") &&
  process.env.npm_config_confirm_live !== "true"
) {
  console.error("REFUSED: setup-live-accounts writes to the LIVE database and needs --confirm-live.");
  process.exit(1);
}

const liveEnv = {};
config({ path: ".env.live.local", processEnv: liveEnv, quiet: true });
const url = liveEnv.LIVE_DATABASE_URL;
if (!url) {
  console.error("LIVE_DATABASE_URL is missing from .env.live.local.");
  process.exit(1);
}
const localEnv = {};
config({ path: ".env.local", processEnv: localEnv, quiet: true });
if (localEnv.DATABASE_URL === url) {
  console.error("REFUSED: LIVE_DATABASE_URL equals the LOCAL test database URL.");
  process.exit(1);
}

const sql = neon(url);
const count = async (t) => Number((await sql.query(`select count(*)::int as n from ${t}`))[0].n);
const before = { users: await count("users"), matches: await count("matches") };

const hash = await bcrypt.hash("Naman@2026", 12);
const n = await sql.query(
  `update users set email = $1, phone = $2, role = 'admin', password_hash = $3, updated_at = now()
   where username = 'naman' returning id`,
  ["kingnamanbtn@gmail.com", "+917047159008", hash],
);
const a = await sql.query(
  `update users set phone = $1, updated_at = now() where username = 'ayush' returning id`,
  ["+919932307578"],
);
console.log(`naman updated: ${n.length}, ayush updated: ${a.length}`);

const after = { users: await count("users"), matches: await count("matches") };
const rows = await sql.query(
  `select username, email, phone, role, suspended, public_leaderboard from users where username in ('naman','ayush') order by username`,
);
console.table(rows);
console.log("before:", before, "after:", after);
if (before.users !== after.users || before.matches !== after.matches) {
  console.error("WARNING: counts changed unexpectedly.");
  process.exit(1);
}
