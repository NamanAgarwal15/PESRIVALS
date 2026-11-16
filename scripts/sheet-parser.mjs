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

const NAMAN_FALLBACK_TEAM = "Belgium";
const AYUSH_FALLBACK_TEAM = "FC Bayern München";

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
      needsReview: NEEDS_REVIEW_ROWS.has(excelRow),
      decidedOnPens: excelRow === PENS_ROW,
      // "EXAMPLE..." remark on Row 6 is template text, not real data.
      remark: remark && !/^EXAMPLE/i.test(remark) ? remark : null,
    });
  }
  return out;
}
