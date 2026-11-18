// Green / yellow confidence for an extracted match. Framework-free.
// Yellow = the model said it was unsure, a deterministic sanity check failed,
// or an optional stat is missing. Everything else is green.

import type { ExtractedMatch, ExtractedSide } from "@/lib/match-schema";
import { STAT_KEYS, STAT_LABELS } from "@/lib/match-stats";

export type Confidence = "green" | "yellow";
export type FieldKey = "goals" | (typeof STAT_KEYS)[number];
export type Side = "left" | "right";

export type ConfidenceReport = {
  /** Yellow fields per side; any field not listed is green. */
  yellow: Record<Side, FieldKey[]>;
  /** Human-readable reasons, one per problem. */
  warnings: string[];
  hasYellow: boolean;
};

const label = (key: FieldKey) => (key === "goals" ? "Goals" : STAT_LABELS[key]);

/**
 * @param modelLow field names the model flagged as uncertain, as "left.shots"
 *                 or "right.goals". Unknown names are ignored.
 */
export function assessConfidence(
  extracted: Pick<ExtractedMatch, "left" | "right">,
  modelLow: readonly string[] = [],
): ConfidenceReport {
  const yellow: Record<Side, Set<FieldKey>> = { left: new Set(), right: new Set() };
  const warnings: string[] = [];
  const flag = (side: Side, key: FieldKey, why: string) => {
    yellow[side].add(key);
    warnings.push(`${side === "left" ? "Left" : "Right"} ${label(key)}: ${why}`);
  };

  for (const raw of modelLow) {
    const [side, key] = raw.split(".");
    if ((side === "left" || side === "right") && (key === "goals" || (STAT_KEYS as readonly string[]).includes(key))) {
      flag(side, key as FieldKey, "the reader was not sure of this number");
    }
  }

  for (const side of ["left", "right"] as const) {
    const s: ExtractedSide = extracted[side];
    if (s.shots !== null && s.shots_on_target !== null && s.shots_on_target > s.shots) {
      flag(side, "shots_on_target", "shots on target is higher than shots");
    }
    if (s.passes !== null && s.successful_passes !== null && s.successful_passes > s.passes) {
      flag(side, "successful_passes", "successful passes is higher than passes");
    }
    for (const key of STAT_KEYS) {
      if (s[key] === null) flag(side, key, "not found on the screenshot");
    }
  }

  const { left, right } = extracted;
  if (left.possession !== null && right.possession !== null && left.possession + right.possession !== 100) {
    flag("left", "possession", `possession adds up to ${left.possession + right.possession}, not 100`);
    flag("right", "possession", `possession adds up to ${left.possession + right.possession}, not 100`);
  }

  const out = { left: [...yellow.left], right: [...yellow.right] };
  return { yellow: out, warnings, hasYellow: out.left.length + out.right.length > 0 };
}
