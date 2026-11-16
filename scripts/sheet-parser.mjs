// Shared parser for "EFOOTIE REALITY .xlsx" (sheet "Match Log", rows 6-37).
// Used by scripts/seed-sheet.mjs ( seeding the LOCAL TEST database ) and by
// tests/analytics.test.ts ( verifying the extraction against known totals ).
//
// Excel Row 12 (Match #7) is an exact duplicate of Row 6 and is SKIPPED, so
// the remaining 31 rows become match_no 1..31 in sheet order.

import { createRequire } from "node:module";

// CJS interop: the xlsx package does not expose readFile via its ESM entry.
const XLSX = createRequire(import.meta.url)("xlsx");

export const SHEET_FILE = "EFOOTIE REALITY .xlsx";
export const SHEET_NAME = "Match Log";

/** Excel Row 12 = Match #7, an exact duplicate of Row 6. */
export const DUPLICATE_ROW = 12;

/** Excel Rows 13-16 (Matches #8-#11): no Date/Host, teams partially blank. */
export const NEEDS_REVIEW_ROWS = new Set([13, 14, 15, 16]);

/** Excel Row 17 (Match #12): draw decided on penalties. */
export const PENS_ROW = 17;

/**
 * The 5 screenshot-only stats for the 21 matches whose original eFootball
 * screenshots were extracted. Keyed by 1-indexed Excel row; every other row
 * (16, 18-26) keeps all five stats as null. Tuple order:
 * [namanOffsides, ayushOffsides, namanFreeKicks, ayushFreeKicks,
 *  namanCrosses, ayushCrosses, namanInterceptions, ayushInterceptions,
 *  namanSaves, ayushSaves]
 */
export const EXTRA_STATS_BY_ROW = {
  6: [1, 2, 2, 5, 3, 2, 39, 37, 1, 2],
  7: [2, 0, 3, 5, 4, 3, 40, 44, 3, 4],
  8: [1, 2, 4, 6, 5, 2, 41, 48, 2, 5],
  9: [1, 2, 2, 4, 10, 3, 30, 45, 1, 6],
  10: [0, 1, 2, 1, 11, 4, 33, 46, 3, 6],
  11: [2, 3, 4, 4, 7, 2, 38, 47, 3, 4],
  13: [1, 1, 2, 1, 10, 2, 28, 32, 5, 0],
  14: [2, 0, 0, 5, 8, 3, 42, 39, 8, 7],
  15: [0, 2, 4, 0, 5, 5, 29, 43, 4, 4],
  17: [1, 0, 2, 4, 2, 5, 53, 67, 7, 4],
  27: [1, 1, 2, 1, 6, 4, 22, 38, 3, 9],
  28: [1, 1, 1, 4, 1, 4, 37, 63, 6, 4],
  29: [1, 3, 5, 3, 2, 1, 41, 50, 3, 5],
  30: [3, 0, 0, 4, 7, 2, 35, 45, 4, 2],
  31: [1, 0, 0, 1, 9, 0, 37, 42, 0, 6],
  32: [5, 1, 1, 7, 10, 2, 35, 50, 8, 12],
  33: [1, 1, 2, 3, 6, 4, 36, 60, 2, 3],
  34: [2, 2, 5, 3, 6, 2, 23, 41, 3, 8],
  35: [2, 0, 1, 3, 5, 1, 30, 48, 6, 6],
  36: [0, 1, 2, 0, 4, 1, 35, 41, 1, 7],
  37: [1, 1, 1, 2, 7, 2, 31, 47, 5, 5],
};

const NAMAN_FALLBACK_TEAM = "Belgium";
const AYUSH_FALLBACK_TEAM = "FC Bayern München";

const EXTRA_KEYS = [
  "namanOffsides",
  "ayushOffsides",
  "namanFreeKicks",
  "ayushFreeKicks",
  "namanCrosses",
  "ayushCrosses",
  "namanInterceptions",
  "ayushInterceptions",
  "namanSaves",
  "ayushSaves",
];

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Excel serial date (days since 1899-12-30) -> "YYYY-MM-DD" (UTC). */
export function excelSerialToISO(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Returns 31 parsed rows in sheet order, each tagged with its Excel row
 * number, already deduplicated (Row 12 skipped) and renumbered 1..31.
 */
export function parseMatchLog(filePath = SHEET_FILE) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found in ${filePath}`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const out = [];
  // Excel rows 6..37 are 0-based indices 5..36.
  for (let r = 5; r < 37; r++) {
    const excelRow = r + 1;
    if (excelRow === DUPLICATE_ROW) continue;
    const row = grid[r] ?? [];

    const dateSerial = num(row[1]);
    const host = str(row[2]);
    const remark = str(row[29]);

    out.push({
      excelRow,
      matchNo: out.length + 1,
      playedAt: dateSerial === null ? null : excelSerialToISO(dateSerial),
      host, // "Naman" | "Ayush" | null
      namanTeam: str(row[3]) ?? NAMAN_FALLBACK_TEAM,
      namanGoals: num(row[4]),
      ayushGoals: num(row[5]),
      ayushTeam: str(row[6]) ?? AYUSH_FALLBACK_TEAM,
      // Only Naman's possession is authoritative; Ayush's = 100 - Naman's.
      namanPossession: num(row[10]),
      namanShots: num(row[12]),
      ayushShots: num(row[13]),
      namanShotsOnTarget: num(row[14]),
      ayushShotsOnTarget: num(row[15]),
      namanPasses: num(row[16]),
      ayushPasses: num(row[17]),
      namanSuccessfulPasses: num(row[18]),
      ayushSuccessfulPasses: num(row[19]),
      namanFouls: num(row[22]),
      ayushFouls: num(row[23]),
      namanCorners: num(row[24]),
      ayushCorners: num(row[25]),
      namanTackles: num(row[26]),
      ayushTackles: num(row[27]),
      // The 5 screenshot-only stats, from the extracted original screenshots.
      ...(EXTRA_STATS_BY_ROW[excelRow] ?? [null, null, null, null, null, null, null, null, null, null])
        .reduce(
          (acc, v, i) => {
            acc[EXTRA_KEYS[i]] = v;
            return acc;
          },
          Object.create(null),
        ),
      needsReview: NEEDS_REVIEW_ROWS.has(excelRow),
      decidedOnPens: excelRow === PENS_ROW,
      // "EXAMPLE..." remark on Row 6 is template text, not real data.
      remark: remark && !/^EXAMPLE/i.test(remark) ? remark : null,
    });
  }
  return out;
}
