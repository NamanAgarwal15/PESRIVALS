// Cached leaderboard for the page, kept apart from leaderboard.ts so that
// module stays framework-free for Vitest. Invalidate with refreshLeaderboard().

import { revalidateTag, unstable_cache } from "next/cache";
import { getLeaderboard } from "@/lib/leaderboard";

export const LEADERBOARD_TAG = "leaderboard";

export const getCachedLeaderboard = unstable_cache(getLeaderboard, ["leaderboard"], {
  tags: [LEADERBOARD_TAG],
  revalidate: 60,
});

/** Expire the cached leaderboard now (match saved/disputed/resolved, name or suspension changed). */
export function refreshLeaderboard(): void {
  revalidateTag(LEADERBOARD_TAG, { expire: 0 });
}
