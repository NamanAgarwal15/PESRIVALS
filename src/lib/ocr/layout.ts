// Normalised (0.0 - 1.0) regions of the eFootball "Full Time" stats screen.
// Fractions of the canonical image, so any resolution of the same layout maps
// to the same crops. These numbers are CALIBRATION CONSTANTS: re-measure them
// against real screenshots whenever the game UI changes, and bump
// PIPELINE_VERSION when you do (that also invalidates cached extractions).

import { STAT_KEYS } from "@/lib/match-stats";

export type Region = { x: number; y: number; w: number; h: number };

export type ScreenLayout = {
  name: string;
  goals: { left: Region; right: Region };
  /** One row per STAT_KEYS entry, in screen order. */
  stats: Record<(typeof STAT_KEYS)[number], { left: Region; right: Region }>;
};

const TABLE_TOP = 0.27;
const TABLE_BOTTOM = 0.93;
const ROW_H = (TABLE_BOTTOM - TABLE_TOP) / STAT_KEYS.length;

function row(index: number) {
  const y = TABLE_TOP + index * ROW_H + ROW_H * 0.15;
  const h = ROW_H * 0.7;
  return {
    left: { x: 0.3, y, w: 0.13, h },
    right: { x: 0.57, y, w: 0.13, h },
  };
}

export const LANDSCAPE_LAYOUT: ScreenLayout = {
  name: "landscape-v1",
  goals: {
    left: { x: 0.38, y: 0.085, w: 0.09, h: 0.07 },
    right: { x: 0.53, y: 0.085, w: 0.09, h: 0.07 },
  },
  stats: Object.fromEntries(STAT_KEYS.map((k, i) => [k, row(i)])) as ScreenLayout["stats"],
};

/**
 * Picks a layout from the aspect ratio. Only the landscape phone/tablet range
 * is mapped; portrait or odd aspect ratios (cropped, rotated, split-screen)
 * return null and go straight to the Gemini fallback instead of being guessed.
 */
export function layoutFor(width: number, height: number): ScreenLayout | null {
  const aspect = width / height;
  return aspect >= 1.5 && aspect <= 2.4 ? LANDSCAPE_LAYOUT : null;
}
