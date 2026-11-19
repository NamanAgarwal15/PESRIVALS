// Self-serve data rights: export everything we hold about a user, and delete
// (anonymise) their account. Framework-free.

import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  deviceSessions,
  matches,
  oauthAccounts,
  otpCodes,
  passwordResetTokens,
  pushSubscriptions,
  rivalries,
  users,
} from "@/db/schema";

export async function buildUserExport(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      efootballId: users.efootballId,
      role: users.role,
      publicLeaderboard: users.publicLeaderboard,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;

  const myRivalries = await db
    .select()
    .from(rivalries)
    .where(or(eq(rivalries.userAId, userId), eq(rivalries.userBId, userId)));
  const rivalryIds = myRivalries.map((r) => r.id);
  const myMatches = rivalryIds.length
    ? await db
        .select()
        .from(matches)
        .where(and(inArray(matches.rivalryId, rivalryIds), eq(matches.status, "confirmed"), isNull(matches.deletedAt)))
    : [];

  const opponentIds = [...new Set(myRivalries.map((r) => (r.userAId === userId ? r.userBId : r.userAId)))];
  const opp = opponentIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, opponentIds))
    : [];
  const name = new Map(opp.map((o) => [o.id, o.username]));

  return {
    exportedAt: new Date().toISOString(),
    profile: user,
    rivalries: myRivalries.map((r) => ({
      id: r.id,
      status: r.status,
      opponent: name.get(r.userAId === userId ? r.userBId : r.userAId) ?? null,
      createdAt: r.createdAt,
      acceptedAt: r.acceptedAt,
    })),
    matches: myMatches.map((m) => {
      const { deletedAt, deletedBy, createdBy, hostUserId, ...rest } = m;
      void deletedAt; void deletedBy; void createdBy; void hostUserId;
      return rest;
    }),
  };
}

export type DeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Anonymises the account: credentials, email, linked identities, devices and
 * push subscriptions are removed and the profile is renamed. Match rows stay so
 * the opponent's history is not destroyed, but the player is suspended (hidden
 * from the leaderboard and unable to sign in).
 */
export async function deleteAccount(userId: string): Promise<DeleteResult> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!user) return { ok: false, error: "Account not found." };
  if (user.role === "admin") {
    const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.suspended, false)));
    if (admins.length <= 1) return { ok: false, error: "You are the last admin. Promote another admin first." };
  }
  await db.delete(oauthAccounts).where(eq(oauthAccounts.userId, userId));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  await db.delete(deviceSessions).where(eq(deviceSessions.userId, userId));
  await db.delete(otpCodes).where(eq(otpCodes.userId, userId));
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  await db
    .update(users)
    .set({
      username: `deleted_${randomBytes(6).toString("hex")}`,
      displayName: "Deleted player",
      email: null,
      efootballId: null,
      passwordHash: null,
      imageUrl: null,
      role: "user",
      publicLeaderboard: false,
      suspended: true,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  return { ok: true };
}
