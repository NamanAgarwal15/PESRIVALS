// Seeds the LOCAL TEST database from "EFOOTIE REALITY .xlsx" (Match Log rows
// 6-37, Row 12 skipped -> 31 matches) for placeholder users naman & ayush.
//
//   npm run db:seed:local             (idempotent: re-imports source='import' rows)
//   npm run db:seed:local -- --reset  (wipes ALL matches of the rivalry first)
//
// SAFETY: reads DATABASE_URL from .env.local only. Refuses to run if it is
// missing or equal to the LIVE database URL in .env.live.local. Never prints
// a connection string.

import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { SHEET_FILE, parseMatchLog } from "./sheet-parser.mjs";

const localEnv = {};
config({ path: ".env.local", processEnv: localEnv, quiet: true });
const url = localEnv.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is missing from .env.local. Nothing was seeded.");
  process.exit(1);
}

// SAFETY GATE: never seed the LIVE database, not even by accident.
const liveEnv = {};
config({ path: ".env.live.local", processEnv: liveEnv, quiet: true });
if (liveEnv.LIVE_DATABASE_URL && liveEnv.LIVE_DATABASE_URL === url) {
  console.error("REFUSED: DATABASE_URL in .env.local equals the LIVE database URL.");
  process.exit(1);
}

const sql = neon(url);
const reset = process.argv.includes("--reset") || process.env.npm_config_reset === "true";

function fail(message) {
  console.error(`VERIFICATION FAILED: ${message}`);
  process.exit(1);
}

function assertEq(label, actual, expected, tolerance = 0) {
  const ok = tolerance > 0 ? Math.abs(actual - expected) <= tolerance : actual === expected;
  if (!ok) fail(`${label}: expected ${expected}, got ${actual}`);
  console.log(`  ok  ${label} = ${actual}`);
}

async function ensureUser(username, displayName) {
  const rows = await sql`
    INSERT INTO users (username, display_name, is_placeholder, onboarded)
    VALUES (${username}, ${displayName}, true, true)
    ON CONFLICT (username) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          is_placeholder = true,
          onboarded = true,
          updated_at = now()
    RETURNING id
  `;
  return rows[0].id;
}

const rows = parseMatchLog(SHEET_FILE);
console.log(`Parsed ${rows.length} rows from ${SHEET_FILE} (Excel Row 12 skipped).`);

const namanId = await ensureUser("naman", "Naman");
const ayushId = await ensureUser("ayush", "Ayush");
console.log("Users ready: naman, ayush (placeholder, onboarded).");

// Canonical a/b ordering: the lower uuid is ALWAYS user_a.
const [aId, bId] = [namanId, ayushId].sort();
const namanIsA = namanId === aId;

let rivalryRows = await sql`
  SELECT id, status FROM rivalries WHERE user_a_id = ${aId} AND user_b_id = ${bId}
`;
let rivalryId;
if (!rivalryRows.length) {
  rivalryRows = await sql`
    INSERT INTO rivalries (user_a_id, user_b_id, status, requested_by, accepted_at)
    VALUES (${aId}, ${bId}, 'active', ${namanId}, now())
    RETURNING id, status
  `;
  rivalryId = rivalryRows[0].id;
  console.log("Created active rivalry naman vs ayush.");
} else {
  rivalryId = rivalryRows[0].id;
  if (rivalryRows[0].status !== "active") {
    await sql`
      UPDATE rivalries SET status = 'active', accepted_at = coalesce(accepted_at, now())
      WHERE id = ${rivalryId}
    `;
    console.log(`Reactivated rivalry (was ${rivalryRows[0].status}).`);
  } else {
    console.log("Reusing existing active rivalry.");
  }
}

if (reset) {
  await sql`DELETE FROM matches WHERE rivalry_id = ${rivalryId}`;
  console.log("--reset: deleted ALL matches for this rivalry.");
} else {
  const del = await sql`
    DELETE FROM matches WHERE rivalry_id = ${rivalryId} AND source = 'import' RETURNING id
  `;
  console.log(`Deleted ${del.length} previous 'import' matches (screenshots preserved).`);
}

// Slot mapping: Naman's sheet columns go to user_a_* when naman is user_a.
function pair(namanValue, ayushValue) {
  return namanIsA ? [namanValue, ayushValue] : [ayushValue, namanValue];
}

let inserted = 0;
for (const row of rows) {
  const [aTeam, bTeam] = pair(row.namanTeam, row.ayushTeam);
  const [aGoals, bGoals] = pair(row.namanGoals, row.ayushGoals);
  const hostUserId =
    row.host === "Naman" ? namanId : row.host === "Ayush" ? ayushId : null;
  // Possession is only trustworthy on Naman's side; the other is 100 - it.
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
      user_a_tackles, user_b_tackles
    ) VALUES (
      ${rivalryId}, ${row.matchNo}, ${row.playedAt}, ${hostUserId}, ${namanId},
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
      ${aTackles}, ${bTackles}
    )
  `;
  inserted++;
}
console.log(`Inserted ${inserted} matches.`);

// Mandatory post-seed verification against the LOCAL TEST database.
console.log("Verifying seeded data:");
const v = (
  await sql`
    SELECT
      count(*)::int AS total,
      sum(CASE WHEN user_a_goals > user_b_goals AND NOT decided_on_pens THEN 1 ELSE 0 END)::int AS a_wins,
      sum(CASE WHEN user_b_goals > user_a_goals AND NOT decided_on_pens THEN 1 ELSE 0 END)::int AS b_wins,
      sum(CASE WHEN decided_on_pens OR user_a_goals = user_b_goals THEN 1 ELSE 0 END)::int AS draws,
      coalesce(sum(user_a_goals), 0)::int AS a_goals,
      coalesce(sum(user_b_goals), 0)::int AS b_goals,
      count(*) FILTER (WHERE needs_review)::int AS needs_review,
      count(*) FILTER (WHERE user_a_shots IS NOT NULL)::int AS stat_matches,
      avg(user_a_shots) AS a_avg_shots,
      avg(user_b_shots) AS b_avg_shots,
      coalesce(sum(user_a_passes), 0)::int AS a_passes,
      coalesce(sum(user_a_successful_passes), 0)::int AS a_succ_passes,
      count(*) FILTER (WHERE decided_on_pens)::int AS pens
    FROM matches
    WHERE rivalry_id = ${rivalryId} AND source = 'import'
  `
)[0];

const naman = (a, b) => (namanIsA ? a : b);
const ayush = (a, b) => (namanIsA ? b : a);

assertEq("total_matches", v.total, 31);
assertEq("naman_wins", naman(v.a_wins, v.b_wins), 22);
assertEq("ayush_wins", ayush(v.a_wins, v.b_wins), 8);
assertEq("draws", v.draws, 1);
assertEq("naman_goals", naman(v.a_goals, v.b_goals), 172);
assertEq("ayush_goals", ayush(v.a_goals, v.b_goals), 116);
assertEq("needs_review_count", v.needs_review, 4);
assertEq("stat_matches_count", v.stat_matches, 30);
assertEq("naman_avg_shots", Number(naman(v.a_avg_shots, v.b_avg_shots)), 16.067, 0.001);
assertEq("ayush_avg_shots", Number(ayush(v.a_avg_shots, v.b_avg_shots)), 9.967, 0.001);
assertEq("naman_total_passes", naman(v.a_passes, v.b_passes), 6022);
assertEq("naman_successful_passes", naman(v.a_succ_passes, v.b_succ_passes), 4239);
assertEq("pens_matches", v.pens, 1);

console.log("Seed complete: all verifications passed. (LOCAL TEST database)");
