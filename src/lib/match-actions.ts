"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { recordAudit } from "@/lib/audit";
import { checkScoreFarming } from "@/lib/anti-sybil";
import { LIMITS, consumeMatchSaveLimits, consumeRateLimit, shouldPushMatch } from "@/lib/rate-limit";
import { sendPushToUser } from "@/lib/push";
import { securityLog } from "@/lib/security-log";
import { refreshLeaderboard } from "@/lib/leaderboard-cache";
import { isAdminUser } from "@/lib/admin";
import {
  type DisputeResult,
  type SaveMatchResult,
  acknowledgeMatch,
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

  const rivalryIdIn = (input as { rivalryId?: unknown } | null)?.rivalryId;
  // Per-user (15/h) and per-rivalry (25/day) ceilings, checked before anything is written.
  const limited = await consumeMatchSaveLimits(session.user.id, rivalryIdIn);
  if (!limited.ok) {
    securityLog("rate_limited", { route: "match_save", userId: session.user.id });
    return { ok: false, error: limited.error };
  }

  const result = await saveMatchForUser(session.user.id, input);

  if (result.ok) {
    const rivalryId = rivalryIdIn;
    if (isUuid(rivalryId)) revalidatePath(`/rivalry/${rivalryId}`);
    revalidatePath("/home");
    refreshLeaderboard();
    // Non-blocking anomaly check; it only raises admin-review flags.
    if (isUuid(rivalryId)) after(() => checkScoreFarming(rivalryId).catch(() => 0));
    const opponentId = result.opponentId;
    const url = isUuid(rivalryId) ? `/rivalry/${rivalryId}` : "/home";
    // The opponent is always told, but rapid saves in one rivalry share a single push (and one replaceable tag).
    after(async () => {
      if (isUuid(rivalryId) && !(await shouldPushMatch(rivalryId).catch(() => true))) return;
      await sendPushToUser(opponentId, {
        title: "New match logged",
        body: `${session.user.username} added match #${result.matchNo}. Confirm it or dispute it if it is wrong; it counts for clan wars after 24 hours.`,
        url,
        tag: isUuid(rivalryId) ? `matches-${rivalryId}` : `match-${result.matchId}`,
      });
    });
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

/** The opponent confirms an uploaded match ("looks right"). Lets a clan-war slot settle without waiting. */
export async function acknowledgeMatchAction(matchId: string): Promise<DisputeResult> {
  const me = await actor();
  const result = await acknowledgeMatch(me.id, matchId);
  if (result.ok) {
    refresh(result.rivalryId);
    notifyAll(result.notify, {
      title: "Match confirmed",
      body: `${me.username} confirmed your match.`,
      url: `/rivalry/${result.rivalryId}`,
      tag: `ack-${matchId}`,
    });
  }
  return result;
}

/** Withdraws your own dispute (or, for an admin, rules on it). The uploader cannot do this. */
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
