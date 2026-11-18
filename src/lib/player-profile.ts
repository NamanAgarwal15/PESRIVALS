// Public player profiles. Career stats are visible for every non-suspended
// player. Individual rivalries and match logs are visible only to the player,
// their rivals (via /rivalry/[id]) and admins, unless the player has left
// public_leaderboard on (peer rivalry privacy). When access is denied the
// private data is never even queried. Framework-free so it is unit-tested.

import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import { outcomeOf } from "@/lib/rivalry-analytics";
import { toAnalyticsMatch } from "@/lib/career-stats";
import { type CareerMatch, summarizeCareer } from "@/lib/leaderboard";
import { type RivalryRelation, getRelationMap } from "@/lib/rivalry-helpers";

export type Viewer = { id: string; role: "user" | "admin" };

/** Peer rivalry privacy rule: who may see a player's individual rivalries/logs. */
export function canSeeRivalryDetail(args: {
  isSelf: boolean;
  viewerRole: "user" | "admin";
  targetPublic: boolean;
}): boolean {
  return args.isSelf || args.viewerRole === "admin" || args.targetPublic;
}

export type PlayerRivalry = {
  rivalryId: string;
  opponentUsername: string;
  opponentName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
};

export type PlayerMatchLog = {
  id: string;
  rivalryId: string;
  matchNo: number;
  aUser: string;
  bUser: string;
  aGoals: number;
  bGoals: number;
  playedAt: string | null;
};

export type PlayerProfile = {
  user: { id: string; username: string; displayName: string; efootballId: string | null };
  career: ReturnType<typeof summarizeCareer>;
  relation: RivalryRelation;
  rivalryId: string | null;
  isSelf: boolean;
  canSeeRivalries: boolean;
  rivalries: PlayerRivalry[];
  recentMatches: PlayerMatchLog[];
};

async function loadUserMatches(userId: string): Promise<CareerMatch[]> {
  const joined = await db
    .select({ match: matches, userAId: rivalries.userAId, userBId: rivalries.userBId })
    .from(matches)
    .innerJoin(rivalries, eq(matches.rivalryId, rivalries.id))
    .where(
      and(
        eq(matches.status, "confirmed"),
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, userId), eq(rivalries.userBId, userId)),
      ),
    );
  return joined.map((j) => ({ ...j.match, userAId: j.userAId, userBId: j.userBId }));
}

/** Null for unknown or suspended players (they have no public profile). */
export async function getPlayerProfile(
  viewer: Viewer,
  username: string,
): Promise<PlayerProfile | null> {
  const [target] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      efootballId: users.efootballId,
      publicLeaderboard: users.publicLeaderboard,
      suspended: users.suspended,
    })
    .from(users)
    .where(eq(users.username, username.trim().toLowerCase()));
  if (!target || target.suspended) return null;

  const isSelf = viewer.id === target.id;
  const own = await loadUserMatches(target.id);
  const career = summarizeCareer(target.id, own);
  const shared = isSelf ? undefined : (await getRelationMap(viewer.id))[target.id];
  const canSeeRivalries = canSeeRivalryDetail({
    isSelf,
    viewerRole: viewer.role,
    targetPublic: target.publicLeaderboard,
  });

  const profile: PlayerProfile = {
    user: {
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      efootballId: target.efootballId,
    },
    career,
    relation: shared?.relation ?? "none",
    rivalryId: shared?.rivalryId ?? null,
    isSelf,
    canSeeRivalries,
    rivalries: [],
    recentMatches: [],
  };
  if (!canSeeRivalries) return profile; // private data is never loaded

  const opponentIds = [
    ...new Set(own.map((m) => (m.userAId === target.id ? m.userBId : m.userAId))),
  ];
  const names = opponentIds.length
    ? await db
        .select({ id: users.id, username: users.username, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, opponentIds))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n]));
  const usernameOf = (id: string) => (id === target.id ? target.username : nameOf.get(id)?.username ?? "?");

  const byRivalry = new Map<string, PlayerRivalry>();
  for (const m of own) {
    const iAmA = m.userAId === target.id;
    const oppId = iAmA ? m.userBId : m.userAId;
    const row =
      byRivalry.get(m.rivalryId) ??
      {
        rivalryId: m.rivalryId,
        opponentUsername: nameOf.get(oppId)?.username ?? "?",
        opponentName: nameOf.get(oppId)?.displayName ?? "?",
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
      };
    const outcome = outcomeOf(toAnalyticsMatch(m, target.id, iAmA));
    row.played += 1;
    if (outcome === "win") row.wins += 1;
    else if (outcome === "draw") row.draws += 1;
    else row.losses += 1;
    byRivalry.set(m.rivalryId, row);
  }
  profile.rivalries = [...byRivalry.values()].sort((a, b) => b.played - a.played);
  profile.recentMatches = [...own]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 15)
    .map((m) => ({
      id: m.id,
      rivalryId: m.rivalryId,
      matchNo: m.matchNo,
      aUser: usernameOf(m.userAId),
      bUser: usernameOf(m.userBId),
      aGoals: m.userAGoals,
      bGoals: m.userBGoals,
      playedAt: m.playedAt,
    }));
  return profile;
}

/** Find any non-suspended player by username or display name. */
export async function searchPlayers(query: string) {
  const q = query.trim().replace(/^@/, "").slice(0, 40);
  if (q.length < 2) return [];
  const like = "%" + q.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
  return db
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.suspended, false), or(ilike(users.username, like), ilike(users.displayName, like))))
    .orderBy(users.username)
    .limit(10);
}
