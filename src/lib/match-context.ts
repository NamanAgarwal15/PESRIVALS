// 1-tap match context options, shared by the upload UI and server validation.

export const PLAYSTYLES = [
  "Possession Game",
  "Quick Counter",
  "Long Ball Counter",
  "Out Wide",
  "Long Ball",
] as const;
export type Playstyle = (typeof PLAYSTYLES)[number];

export const MATCH_CONTEXTS = [
  "Friendly",
  "Ranked",
  "Cup",
  "Rematch",
  "Comeback",
  "Last-Minute Winner",
] as const;
export type MatchContextTag = (typeof MATCH_CONTEXTS)[number];
