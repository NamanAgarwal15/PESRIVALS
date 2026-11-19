"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { checkScoreFarming } from "@/lib/anti-sybil";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";
import { sendPushToUser } from "@/lib/push";
import { securityLog } from "@/lib/security-log";
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
    // Non-blocking anomaly check; it only raises admin-review flags.
    if (isUuid(rivalryId)) after(() => checkScoreFarming(rivalryId).catch(() => 0));
    const opponentId = result.opponentId;
    const url = isUuid(rivalryId) ? `/rivalry/${rivalryId}` : "/home";
    after(() =>
      sendPushToUser(opponentId, {
        title: "New match logged",
        body: `${session.user.username} added match #${result.matchNo}. Check it and dispute if it is wrong.`,
        url,
        tag: `match-${result.matchId}`,
      }),
    );
  }
  return result;
}

async function actor() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  return {
    id: session.user.id,
    username: session.user.username,
    isAdmin: await isAdminUser(session.user.id),
  };
}

function notifyAll(ids: string[], payload: Parameters<typeof sendPushToUser>[1]) {
  after(async () => {
    await Promise.all(ids.map((id) => sendPushToUser(id, payload)));
  });
}

function refresh(rivalryId: string) {
  revalidatePath(`/rivalry/${rivalryId}`);
  revalidatePath("/home");
  revalidatePath("/leaderboard");
  refreshLeaderboard();
}

/** Flags a confirmed match as disputed so it stops counting until resolved. */
export async function disputeMatchAction(matchId: string, reason?: unknown): Promise<DisputeResult> {
  const me = await actor();
  // Repeated disputes are logged and throttled (abuse / harassment signal).
  const rl = await consumeRateLimit(`dispute:${me.id}`, LIMITS.dispute.max, LIMITS.dispute.windowMinutes);
  if (!rl.ok) {
    securityLog("dispute_spike", { userId: me.id });
    return { ok: false, error: "Too many disputes. Try again later." };
  }
  const result = await disputeMatch(me.id, me.isAdmin, matchId, typeof reason === "string" ? reason : undefined);
  if (result.ok) {
    securityLog("dispute_created", { userId: me.id, matchId, rivalryId: result.rivalryId }, "info");
    refresh(result.rivalryId);
    notifyAll(result.notify, {
      title: "Match disputed",
      body: `${me.username} disputed a match. It is paused until resolved.`,
      url: `/rivalry/${result.rivalryId}`,
      tag: `dispute-${matchId}`,
    });
  }
  return result;
}

/** Re-confirms a disputed match so it counts again. */
export async function resolveMatchDisputeAction(matchId: string): Promise<DisputeResult> {
  const me = await actor();
  const result = await resolveMatchDispute(me.id, me.isAdmin, matchId);
  if (result.ok) {
    if (me.isAdmin) await recordAudit(me.id, "match.resolve_dispute", "match", matchId);
    refresh(result.rivalryId);
    notifyAll(result.notify, {
      title: "Dispute resolved",
      body: `${me.username} confirmed the match. It counts again.`,
      url: `/rivalry/${result.rivalryId}`,
      tag: `dispute-${matchId}`,
    });
  }
  return result;
}
