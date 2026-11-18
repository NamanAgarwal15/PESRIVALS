"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { refreshLeaderboard } from "@/lib/leaderboard-cache";
import { isAdminUser } from "@/lib/admin";
import {
  type DisputeResult,
  type SaveMatchResult,
  disputeMatch,
  resolveMatchDispute,
  saveMatchForUser,
} from "@/lib/match-helpers";
import type { SaveMatchInput } from "@/lib/match-schema";
import { isUuid } from "@/lib/rivalry-helpers";

/**
 * Saves a match that was extracted from a screenshot.
 *
 * `input` comes from the browser and is treated as untrusted: the session
 * decides who is acting, and saveMatchForUser re-validates every number and
 * re-checks rivalry membership.
 */
export async function saveExtractedMatch(input: SaveMatchInput): Promise<SaveMatchResult> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");

  const result = await saveMatchForUser(session.user.id, input);

  if (result.ok) {
    const rivalryId = (input as { rivalryId?: unknown } | null)?.rivalryId;
    if (isUuid(rivalryId)) revalidatePath(`/rivalry/${rivalryId}`);
    revalidatePath("/home");
    refreshLeaderboard();
  }
  return result;
}

async function actor() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  return { id: session.user.id, isAdmin: await isAdminUser(session.user.id) };
}

function refresh(rivalryId: string) {
  revalidatePath(`/rivalry/${rivalryId}`);
  revalidatePath("/home");
  revalidatePath("/leaderboard");
  refreshLeaderboard();
}

/** Flags a confirmed match as disputed so it stops counting until resolved. */
export async function disputeMatchAction(matchId: string, reason?: string): Promise<DisputeResult> {
  const me = await actor();
  const result = await disputeMatch(me.id, me.isAdmin, matchId, reason);
  if (result.ok) refresh(result.rivalryId);
  return result;
}

/** Re-confirms a disputed match so it counts again. */
export async function resolveMatchDisputeAction(matchId: string): Promise<DisputeResult> {
  const me = await actor();
  const result = await resolveMatchDispute(me.id, me.isAdmin, matchId);
  if (result.ok) refresh(result.rivalryId);
  return result;
}
