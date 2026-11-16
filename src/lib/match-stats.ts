// Plain constants and pure functions about matches. No database, no zod:
// safe to import from Client Components.

/** The 13 per-side stats on the eFootball Full Time screen, in screen order. */
export const STAT_KEYS = [
  "possession",
  "shots",
  "shots_on_target",
  "fouls",
  "offsides",
  "corners",
  "free_kicks",
  "passes",
  "successful_passes",
  "crosses",
  "interceptions",
  "tackles",
  "saves",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

export const STAT_LABELS: Record<StatKey, string> = {
  possession: "Possession (%)",
  shots: "Shots",
  shots_on_target: "Shots on target",
  fouls: "Fouls",
  offsides: "Offsides",
  corners: "Corner kicks",
  free_kicks: "Free kicks",
  passes: "Passes",
  successful_passes: "Successful passes",
  crosses: "Crosses",
  interceptions: "Interceptions",
  tackles: "Tackles",
  saves: "Saves",
};

export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const SCREENSHOT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type MatchOutcome = "win" | "draw" | "loss";

/**
 * Result of a match from one player's side.
 * PESRIVALS rule: a match decided on penalties is ALWAYS a draw, whatever
 * the score says.
 */
export function matchOutcome(
  myGoals: number,
  opponentGoals: number,
  decidedOnPens: boolean,
): MatchOutcome {
  if (decidedOnPens || myGoals === opponentGoals) return "draw";
  return myGoals > opponentGoals ? "win" : "loss";
}
