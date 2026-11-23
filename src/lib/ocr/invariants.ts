// Domain invariants for an extracted match. A locally OCR'd result that breaks
// any of them is NOT shown to the user: it is re-read by Gemini instead.
// (Gemini results keep the existing yellow-flag behaviour in confidence.ts.)

import type { ExtractedMatch } from "@/lib/match-schema";

export function checkInvariants(m: Pick<ExtractedMatch, "left" | "right">): string[] {
  const problems: string[] = [];
  const { left, right } = m;

  if (left.possession === null || right.possession === null) {
    problems.push("possession missing");
  } else {
    const sum = left.possession + right.possession;
    if (sum < 99 || sum > 101) problems.push(`possession sums to ${sum}`);
  }

  for (const [name, s] of [["left", left], ["right", right]] as const) {
    if (s.possession !== null && (s.possession < 0 || s.possession > 100)) problems.push(`${name} possession out of range`);
    if (s.shots !== null && s.shots_on_target !== null && s.shots_on_target > s.shots) {
      problems.push(`${name} shots on target > shots`);
    }
    if (s.shots_on_target !== null && s.goals > s.shots_on_target) {
      problems.push(`${name} goals > shots on target`);
    }
    if (s.passes !== null && s.successful_passes !== null) {
      if (s.successful_passes > s.passes) problems.push(`${name} successful passes > passes`);
      const accuracy = s.passes === 0 ? 0 : (s.successful_passes / s.passes) * 100;
      if (accuracy < 0 || accuracy > 100) problems.push(`${name} pass accuracy out of range`);
    }
    // A full-time screen with no shots, passes or possession is a misparse.
    if (s.passes === 0 && s.shots !== null && s.shots > 0) problems.push(`${name} shots without passes`);
  }
  return problems;
}
