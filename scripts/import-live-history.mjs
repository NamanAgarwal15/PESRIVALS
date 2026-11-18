// Imports the remaining 30 historical matches (Excel Rows 7-37, skipping the
// duplicate Row 12 and the already-uploaded Row 6 / Match #1) into the LIVE
// Neon database for the existing "naman" vs "ayush" rivalry.
//
//   node scripts/import-live-history.mjs --confirm-live
//
// SAFETY: reads LIVE_DATABASE_URL from .env.live.local only, refuses to run
// without --confirm-live, refuses to touch the LOCAL TEST database, never
// creates users, and never deletes source='screenshot' matches. Never prints
// a connection string.

import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { SHEET_FILE, parseMatchLog } from "./sheet-parser.mjs";

if (
  !process.argv.includes("--confirm-live") &&
  process.env.npm_config_confirm_live !== "true"
) {
  console.error(
    "REFUSED: import-live-history writes to the LIVE database and needs --confirm-live.",
  );
  console.error("Nothing was loaded and no connection was attempted.");
  process.exit(1);
}

const liveEnv = {};
config({ path: ".env.live.local", processEnv: liveEnv, quiet: true });
const url = liveEnv.LIVE_DATABASE_URL;
if (!url) {
  console.error("LIVE_DATABASE_URL is missing from .env.live.local.");
  process.exit(1);
}

// SAFETY GATE: never run against the LOCAL TEST database, not even by accident.
const localEnv = {};
config({ path: ".env.local", processEnv: localEnv, quiet: true });
if (localEnv.DATABASE_URL === url) {
  console.error("REFUSED: LIVE_DATABASE_URL equals the LOCAL test database URL.");
  process.exit(1);
}

const sql = neon(url);

function fail(message) {
  console.error(`FAILED: ${message}`);
  process.exit(1);
}

function assertEq(label, actual, expected) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  console.log(`  ok  ${label} = ${actual}`);
}

// --- USERS & RIVALRY (never created, only looked up) ---

const [namanRow] = await sql`SELECT id FROM users WHERE username = 'naman'`;
const [ayushRow] = await sql`SELECT id FROM users WHERE username = 'ayush'`;
if (!namanRow || !ayushRow) {
  fail("Live users 'naman' and/or 'ayush' not found. Nothing was imported.");
}
const namanId = namanRow.id;
const ayushId = ayushRow.id;

const [aId, bId] = [namanId, ayushId].sort();
const [rivalry] = await sql`
  SELECT id FROM rivalries WHERE user_a_id = ${aId} AND user_b_id = ${bId} AND status = 'active'
`;
if (!rivalry) {
  fail("No ACTIVE rivalry found between 'naman' and 'ayush'. Nothing was imported.");
}
const rivalryId = rivalry.id;
const namanIsA = namanId === aId;
console.log("Found live users and their active rivalry.");

// --- PRECONDITIONS & IDEMPOTENCY ---

const [{ screenshots }] = await sql`
  SELECT count(*)::int AS screenshots FROM matches
  WHERE rivalry_id = ${rivalryId} AND source = 'screenshot'
`;
if (screenshots < 1) {
  fail(
    `Expected at least 1 existing screenshot match (Match #1) in this rivalry, found ${screenshots}.`,
  );
}
const del = await sql`
  DELETE FROM matches WHERE rivalry_id = ${rivalryId} AND source = 'import' RETURNING id
`;
console.log(
  `Existing screenshot matches kept: ${screenshots}. Deleted ${del.length} prior 'import' matches (idempotency).`,
);

// --- IMPORT (Excel Rows 7-37, Row 12 skipped, Row 6 already uploaded) ---

const rows = parseMatchLog(SHEET_FILE).filter((r) => r.excelRow !== 6);
if (rows.length !== 30) fail(`Expected 30 rows after skipping Row 6, got ${rows.length}`);

function pair(namanValue, ayushValue) {
  return namanIsA ? [namanValue, ayushValue] : [ayushValue, namanValue];
}

let inserted = 0;
for (const row of rows) {
  const matchNo = row.matchNo + 1; // sheet matchNo 1..30 -> 2..31 (Match #1 exists)
  const [aTeam, bTeam] = pair(row.namanTeam, row.ayushTeam);
  const [aGoals, bGoals] = pair(row.namanGoals, row.ayushGoals);
  const hostUserId =
    row.host === "Naman" ? namanId : row.host === "Ayush" ? ayushId : null;
  const [aPossession, bPossession] =
    row.namanPossession === null
      ? [null, null]
      : pair(row.namanPossession, 100 - row.namanPossession);
  const [aShots, bShots] = pair(row.namanShots, row.ayushShots);
  const [aSoT, bSoT] = pair(row.namanShotsOnTarget, row.ayushShotsOnTarget);
  const [aPasses, bPasses] = pair(row.namanPasses, row.ayushPasses);
  const [aSucc, bSucc] = pair(row.namanSuccessfulPasses, row.ayushSuccessfulPasses);
  const [aFouls, bFouls] = pair(row.namanFouls, row.ayushFouls);
  const [aCorners, bCorners] = pair(row.namanCorners, row.ayushCorners);
  const [aTackles, bTackles] = pair(row.namanTackles, row.ayushTackles);
  const [aOffsides, bOffsides] = pair(row.namanOffsides, row.ayushOffsides);
  const [aFreeKicks, bFreeKicks] = pair(row.namanFreeKicks, row.ayushFreeKicks);
  const [aCrosses, bCrosses] = pair(row.namanCrosses, row.ayushCrosses);
  const [aInterceptions, bInterceptions] = pair(
    row.namanInterceptions,
    row.ayushInterceptions,
  );
  const [aSaves, bSaves] = pair(row.namanSaves, row.ayushSaves);

  await sql`
    INSERT INTO matches (
      rivalry_id, match_no, played_at, host_user_id, created_by,
      source, status, needs_review, source_sheet_row,
      user_a_team, user_b_team, user_a_goals, user_b_goals,
      decided_on_pens, remark,
      user_a_possession, user_b_possession,
      user_a_shots, user_b_shots,
      user_a_shots_on_target, user_b_shots_on_target,
      user_a_passes, user_b_passes,
      user_a_successful_passes, user_b_successful_passes,
      user_a_fouls, user_b_fouls,
      user_a_corners, user_b_corners,
      user_a_tackles, user_b_tackles,
      user_a_offsides, user_b_offsides,
      user_a_free_kicks, user_b_free_kicks,
      user_a_crosses, user_b_crosses,
      user_a_interceptions, user_b_interceptions,
      user_a_saves, user_b_saves
    ) VALUES (
      ${rivalryId}, ${matchNo}, ${row.playedAt}, ${hostUserId}, ${namanId},
      'import', 'confirmed', ${row.needsReview}, ${row.excelRow},
      ${aTeam}, ${bTeam}, ${aGoals}, ${bGoals},
      ${row.decidedOnPens}, ${row.remark},
      ${aPossession}, ${bPossession},
      ${aShots}, ${bShots},
      ${aSoT}, ${bSoT},
      ${aPasses}, ${bPasses},
      ${aSucc}, ${bSucc},
      ${aFouls}, ${bFouls},
      ${aCorners}, ${bCorners},
      ${aTackles}, ${bTackles},
      ${aOffsides}, ${bOffsides},
      ${aFreeKicks}, ${bFreeKicks},
      ${aCrosses}, ${bCrosses},
      ${aInterceptions}, ${bInterceptions},
      ${aSaves}, ${bSaves}
    )
  `;
  inserted++;
}
console.log(`Inserted ${inserted} imported matches (match_no 2..31).`);

console.log("Verifying live data:");
const v = (
  await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE source = 'screenshot')::int AS screenshots,
      count(*) FILTER (WHERE source = 'import')::int AS imports,
      sum(CASE WHEN user_a_goals > user_b_goals AND NOT decided_on_pens THEN 1 ELSE 0 END)::int AS a_wins,
      sum(CASE WHEN user_b_goals > user_a_goals AND NOT decided_on_pens THEN 1 ELSE 0 END)::int AS b_wins,
      sum(CASE WHEN decided_on_pens OR user_a_goals = user_b_goals THEN 1 ELSE 0 END)::int AS draws,
      coalesce(sum(user_a_goals), 0)::int AS a_goals,
      coalesce(sum(user_b_goals), 0)::int AS b_goals
    FROM matches WHERE rivalry_id = ${rivalryId}
  `
)[0];

// Extra stats enriched: 20 imported enriched rows + the existing screenshot
// Match #1 (counted as enriched per the release spec: 20 imported + 1 = 21).
const [{ enriched }] = await sql`
  SELECT count(*)::int AS enriched FROM matches
  WHERE rivalry_id = ${rivalryId}
    AND (user_a_offsides IS NOT NULL OR user_b_offsides IS NOT NULL
         OR user_a_free_kicks IS NOT NULL OR user_b_free_kicks IS NOT NULL
         OR user_a_crosses IS NOT NULL OR user_b_crosses IS NOT NULL
         OR user_a_interceptions IS NOT NULL OR user_b_interceptions IS NOT NULL
         OR user_a_saves IS NOT NULL OR user_b_saves IS NOT NULL)
`;
const screenshotHasExtra = await sql`
  SELECT 1 FROM matches
  WHERE rivalry_id = ${rivalryId} AND source = 'screenshot'
    AND (user_a_offsides IS NOT NULL OR user_a_free_kicks IS NOT NULL
         OR user_a_crosses IS NOT NULL OR user_a_interceptions IS NOT NULL
         OR user_a_saves IS NOT NULL
         OR user_b_offsides IS NOT NULL OR user_b_free_kicks IS NOT NULL
         OR user_b_crosses IS NOT NULL OR user_b_interceptions IS NOT NULL
         OR user_b_saves IS NOT NULL)
  LIMIT 1
`;
const enrichedTotal = enriched + (screenshotHasExtra.length ? 0 : 1);

const naman = (a, b) => (namanIsA ? a : b);
const ayush = (a, b) => (namanIsA ? b : a);

assertEq("total_matches", v.total, 31);
assertEq("screenshot_matches_kept", v.screenshots, 1);
assertEq("imported_matches", v.imports, 30);
assertEq("naman_wins", naman(v.a_wins, v.b_wins), 22);
assertEq("ayush_wins", ayush(v.a_wins, v.b_wins), 8);
assertEq("draws", v.draws, 1);
assertEq("naman_goals", naman(v.a_goals, v.b_goals), 172);
assertEq("ayush_goals", ayush(v.a_goals, v.b_goals), 116);
assertEq("enriched_extra_stats_matches", enrichedTotal, 21);

console.log("Live import complete: all verifications passed. (LIVE database)");
