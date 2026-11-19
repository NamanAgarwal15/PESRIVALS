// Zod schemas for an extracted match. Used by the Gemini extractor AND by the
// save action, so a payload edited in the browser is held to exactly the
// same rules as one that came straight from Gemini.

import { z } from "zod";
import { MATCH_CONTEXTS, PLAYSTYLES } from "@/lib/match-context";

// smallint columns; no real match gets anywhere near this.
const count = z.number().int().min(0).max(2000).nullable();

export const extractedSideSchema = z
  .object({
    team: z.string().trim().min(1).max(60),
    goals: z.number().int().min(0).max(99),
    possession: z.number().int().min(0).max(100).nullable(),
    shots: count,
    shots_on_target: count,
    fouls: count,
    offsides: count,
    corners: count,
    free_kicks: count,
    passes: count,
    successful_passes: count,
    crosses: count,
    interceptions: count,
    tackles: count,
    saves: count,
  })
  // Same rules as the CHECK constraints on the matches table.
  .superRefine((side, ctx) => {
    if (
      side.shots !== null &&
      side.shots_on_target !== null &&
      side.shots_on_target > side.shots
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["shots_on_target"],
        message: "Shots on target cannot exceed shots",
      });
    }
    if (
      side.passes !== null &&
      side.successful_passes !== null &&
      side.successful_passes > side.passes
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["successful_passes"],
        message: "Successful passes cannot exceed passes",
      });
    }
  });

export const extractedMatchSchema = z.object({
  left: extractedSideSchema,
  right: extractedSideSchema,
});

export type ExtractedSide = z.infer<typeof extractedSideSchema>;
export type ExtractedMatch = z.infer<typeof extractedMatchSchema>;

export const saveMatchInputSchema = z.object({
  rivalryId: z.uuid(),
  extracted: extractedMatchSchema,
  // No defaults: the player has to say which side they were and who hosted.
  mySide: z.enum(["left", "right"]),
  host: z.enum(["home", "away"]),
  decidedOnPens: z.boolean().default(false),
  // Optional 1-tap context. Anything outside the allowed lists is rejected.
  myPlaystyle: z.enum(PLAYSTYLES).nullish().transform((v) => v ?? null),
  opponentPlaystyle: z.enum(PLAYSTYLES).nullish().transform((v) => v ?? null),
  matchContext: z.enum(MATCH_CONTEXTS).nullish().transform((v) => v ?? null),
  isExtraTime: z.boolean().default(false),
  // Set by the browser when any field was yellow; the server also re-checks.
  needsReview: z.boolean().default(false),
  remark: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v))
    .nullish()
    .transform((v) => v ?? null),
});

export type SaveMatchInput = z.input<typeof saveMatchInputSchema>;
