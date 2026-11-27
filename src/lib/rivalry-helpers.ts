// Rivalry logic that talks to the database. Framework-free on purpose (no
// next/* imports) so it can be exercised directly by Vitest. Every function
// takes the acting user's id explicitly and enforces its own authorization;
// the server actions in rivalry-actions.ts only add the session lookup.

import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { rivalries, users } from "@/db/schema";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Returns [userAId, userBId] with the lower uuid first, which is the only
 * order the database accepts (CHECK rivalries_user_order). Throws for a
 * self-rivalry.
 */
export function canonicalPair(id1: string, id2: string): [string, string] {
  const a = id1.toLowerCase();
  const b = id2.toLowerCase();
  if (a === b) throw new Error("A rivalry needs two different users");
  return a < b ? [a, b] : [b, a];
}

// How an existing rivalry row looks from the current user's side.
export type RivalryRelation =
  | "none"
  | "pending_sent"
  | "pending_received"
  | "active"
  | "declined"
  | "blocked";

type RivalryRow = typeof rivalries.$inferSelect;

function relationFor(row: RivalryRow | undefined, currentUserId: string): RivalryRelation {
  if (!row) return "none";
  if (row.status === "pending") {
    return row.requestedBy === currentUserId ? "pending_sent" : "pending_received";
  }
  // An archived rivalry (the other player was suspended or deleted) cannot be acted on: shown as unavailable.
  return row.status === "archived" ? "blocked" : row.status;
}

export type RivalryOpponent = {
  id: string;
  username: string;
  displayName: string;
  imageUrl: string | null;
};

const opponentColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  imageUrl: users.imageUrl,
};

// Correlated count; "rivalries" is the outer table in every query that uses it.
const matchCountSql = sql<number>`(SELECT count(*)::int FROM matches m WHERE m.rivalry_id = "rivalries"."id" AND m.status = 'confirmed' AND m.deleted_at IS NULL)`;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type UserSearchResult = RivalryOpponent & {
  relation: RivalryRelation;
  rivalryId: string | null;
};

/** "@Naman " -> "naman"; null when it is not a searchable username prefix. */
export function normalizeUsernameQuery(query: unknown): string | null {
  if (typeof query !== "string") return null;
  const q = query.trim().replace(/^@+/, "").trim().toLowerCase();
  return /^[a-z0-9_]{2,20}$/.test(q) ? q : null;
}

export async function searchUsersByUsername(
  currentUserId: string,
  query: unknown,
): Promise<UserSearchResult[]> {
  const q = normalizeUsernameQuery(query);
  if (!q || !isUuid(currentUserId)) return [];

  // "_" is a single-character wildcard in LIKE, and it is legal in usernames.
  const prefix = `${q.replace(/_/g, "\\_")}%`;

  const found = await db
    .select(opponentColumns)
    .from(users)
    .where(
      and(
        like(users.username, prefix),
        ne(users.id, currentUserId),
        eq(users.onboarded, true),
        eq(users.isPlaceholder, false),
      ),
    )
    .orderBy(asc(users.username))
    .limit(10);
  if (!found.length) return [];

  const ids = found.map((u) => u.id);
  const existing = await db
    .select()
    .from(rivalries)
    .where(
      or(
        and(eq(rivalries.userAId, currentUserId), inArray(rivalries.userBId, ids)),
        and(eq(rivalries.userBId, currentUserId), inArray(rivalries.userAId, ids)),
      ),
    );
  const byOpponent = new Map(
    existing.map((r) => [r.userAId === currentUserId ? r.userBId : r.userAId, r]),
  );

  return found.map((u) => {
    const row = byOpponent.get(u.id);
    return { ...u, relation: relationFor(row, currentUserId), rivalryId: row?.id ?? null };
  });
}

// ---------------------------------------------------------------------------
// Send / respond / cancel
// ---------------------------------------------------------------------------

export type RivalryMutationResult =
  | {
      ok: true;
      rivalryId: string;
      /** The relation after the change, from the current user's side. */
      relation: RivalryRelation;
      /** True when a challenge met an opposite pending challenge and became active. */
      autoAccepted?: boolean;
    }
  | { ok: false; error: string };

const fail = (error: string): RivalryMutationResult => ({ ok: false, error });

export async function sendRivalryRequest(
  currentUserId: string,
  targetUserId: unknown,
): Promise<RivalryMutationResult> {
  if (!isUuid(currentUserId)) return fail("You need to be logged in");
  if (!isUuid(targetUserId)) return fail("User not found");
  const me = currentUserId.toLowerCase();
  const target = targetUserId.toLowerCase();
  if (me === target) return fail("You cannot challenge yourself");

  // Rate limit: max 20 invites per hour per user.
  const rl = await consumeRateLimit(`invite:${me}`, LIMITS.rivalryInvite.max, LIMITS.rivalryInvite.windowMinutes);
  if (!rl.ok) return fail("Too many challenges sent. Try again in about an hour.");

  const people = await db
    .select({
      id: users.id,
      onboarded: users.onboarded,
      isPlaceholder: users.isPlaceholder,
    })
    .from(users)
    .where(inArray(users.id, [me, target]));
  const sender = people.find((p) => p.id === me);
  const recipient = people.find((p) => p.id === target);
  if (!sender || !sender.onboarded || sender.isPlaceholder) {
    return fail("Finish setting up your account first");
  }
  if (!recipient || !recipient.onboarded || recipient.isPlaceholder) {
    return fail("User not found");
  }

  const [userAId, userBId] = canonicalPair(me, target);
  const pairIs = and(eq(rivalries.userAId, userAId), eq(rivalries.userBId, userBId));

  // Two passes at most: the second only runs if another request created the
  // row between our read and our insert.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [existing] = await db.select().from(rivalries).where(pairIs);

    if (!existing) {
      const [created] = await db
        .insert(rivalries)
        .values({ userAId, userBId, status: "pending", requestedBy: me })
        .onConflictDoNothing({ target: [rivalries.userAId, rivalries.userBId] })
        .returning({ id: rivalries.id });
      if (created) return { ok: true, rivalryId: created.id, relation: "pending_sent" };
      continue;
    }

    switch (existing.status) {
      case "active":
        return fail("Already rivals");

      case "blocked":
      case "archived":
        return fail("Cannot send request to this user");

      case "pending": {
        if (existing.requestedBy === me) return fail("Request already pending");
        // They already challenged us: a challenge back is an acceptance.
        const [accepted] = await db
          .update(rivalries)
          .set({ status: "active", acceptedAt: new Date() })
          .where(
            and(
              eq(rivalries.id, existing.id),
              eq(rivalries.status, "pending"),
              ne(rivalries.requestedBy, me),
            ),
          )
          .returning({ id: rivalries.id });
        if (accepted) {
          return { ok: true, rivalryId: accepted.id, relation: "active", autoAccepted: true };
        }
        continue;
      }

      case "declined": {
        const [reopened] = await db
          .update(rivalries)
          .set({
            status: "pending",
            requestedBy: me,
            acceptedAt: null,
            createdAt: new Date(),
          })
          .where(and(eq(rivalries.id, existing.id), eq(rivalries.status, "declined")))
          .returning({ id: rivalries.id });
        if (reopened) {
          return { ok: true, rivalryId: reopened.id, relation: "pending_sent" };
        }
        continue;
      }
    }
  }

  return fail("Something changed, please try again");
}


export async function respondToRivalryRequest(
  currentUserId: string,
  rivalryId: unknown,
  decision: unknown,
): Promise<RivalryMutationResult> {
  if (decision !== "accept" && decision !== "decline") return fail("Invalid choice");
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return fail("Request not found");

  const [row] = await db.select().from(rivalries).where(eq(rivalries.id, rivalryId));
  // Same answer for "does not exist" and "not yours", so ids cannot be probed.
  if (!row || (row.userAId !== currentUserId && row.userBId !== currentUserId)) {
    return fail("Request not found");
  }
  if (row.status !== "pending") return fail("This request is no longer pending");
  if (row.requestedBy === currentUserId) {
    return fail("You cannot respond to your own request");
  }

  // The WHERE repeats every check so a concurrent change cannot slip through.
  const [updated] = await db
    .update(rivalries)
    .set(
      decision === "accept"
        ? { status: "active", acceptedAt: new Date() }
        : { status: "declined", acceptedAt: null },
    )
    .where(
      and(
        eq(rivalries.id, row.id),
        eq(rivalries.status, "pending"),
        ne(rivalries.requestedBy, currentUserId),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    )
    .returning({ id: rivalries.id });
  if (!updated) return fail("This request is no longer pending");

  return {
    ok: true,
    rivalryId: updated.id,
    relation: decision === "accept" ? "active" : "declined",
  };
}

export async function cancelRivalryRequest(
  currentUserId: string,
  rivalryId: unknown,
): Promise<RivalryMutationResult> {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return fail("Request not found");

  // One statement: only the sender's own pending request can match.
  const [deleted] = await db
    .delete(rivalries)
    .where(
      and(
        eq(rivalries.id, rivalryId),
        eq(rivalries.requestedBy, currentUserId),
        eq(rivalries.status, "pending"),
      ),
    )
    .returning({ id: rivalries.id });
  if (!deleted) return fail("Request not found");

  return { ok: true, rivalryId: deleted.id, relation: "none" };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type RivalrySummary = {
  id: string;
  opponent: RivalryOpponent;
  matchCount: number;
  createdAt: Date;
  acceptedAt: Date | null;
};

export type UserRivalries = {
  activeRivalries: RivalrySummary[];
  incomingRequests: RivalrySummary[];
  sentRequests: RivalrySummary[];
};

export async function getUserRivalries(currentUserId: string): Promise<UserRivalries> {
  const out: UserRivalries = {
    activeRivalries: [],
    incomingRequests: [],
    sentRequests: [],
  };
  if (!isUuid(currentUserId)) return out;

  const rows = await db
    .select({
      id: rivalries.id,
      status: rivalries.status,
      requestedBy: rivalries.requestedBy,
      createdAt: rivalries.createdAt,
      acceptedAt: rivalries.acceptedAt,
      opponent: opponentColumns,
      matchCount: matchCountSql,
    })
    .from(rivalries)
    .innerJoin(
      users,
      sql`${users.id} = CASE WHEN ${rivalries.userAId} = ${currentUserId} THEN ${rivalries.userBId} ELSE ${rivalries.userAId} END`,
    )
    .where(
      and(
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
        inArray(rivalries.status, ["active", "pending"]),
      ),
    )
    .orderBy(desc(rivalries.createdAt))
    .limit(500);

  for (const { status, requestedBy, ...summary } of rows) {
    if (status === "active") out.activeRivalries.push(summary);
    else if (requestedBy === currentUserId) out.sentRequests.push(summary);
    else out.incomingRequests.push(summary);
  }
  return out;
}

export type RivalryDetail = {
  id: string;
  me: RivalryOpponent;
  opponent: RivalryOpponent;
  matchCount: number;
  acceptedAt: Date | null;
};

/**
 * Loads an ACTIVE rivalry for one of its two members. Returns null for a
 * malformed id, a missing or non-active rivalry, or a user who is not in it.
 */
export async function getRivalryForMember(
  currentUserId: string,
  rivalryId: unknown,
): Promise<RivalryDetail | null> {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return null;

  const userA = alias(users, "user_a");
  const userB = alias(users, "user_b");
  const profile = (u: typeof userA | typeof userB) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    imageUrl: u.imageUrl,
  });

  const [row] = await db
    .select({
      id: rivalries.id,
      acceptedAt: rivalries.acceptedAt,
      a: profile(userA),
      b: profile(userB),
      matchCount: matchCountSql,
    })
    .from(rivalries)
    .innerJoin(userA, eq(userA.id, rivalries.userAId))
    .innerJoin(userB, eq(userB.id, rivalries.userBId))
    .where(
      and(
        eq(rivalries.id, rivalryId),
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );
  if (!row) return null;

  const iAmA = row.a.id === currentUserId;
  return {
    id: row.id,
    me: iAmA ? row.a : row.b,
    opponent: iAmA ? row.b : row.a,
    matchCount: row.matchCount,
    acceptedAt: row.acceptedAt,
  };
}

/** Cheap yes/no version of getRivalryForMember, for the proxy. */
export async function isActiveRivalryMember(
  currentUserId: string,
  rivalryId: unknown,
): Promise<boolean> {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return false;
  const [row] = await db
    .select({ id: rivalries.id })
    .from(rivalries)
    .where(
      and(
        eq(rivalries.id, rivalryId),
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );
  return Boolean(row);
}

/**
 * How the current user relates to every other user they share a rivalry row
 * with, keyed by the other user's id. Used by the leaderboard's request buttons.
 */
export async function getRelationMap(
  currentUserId: string,
): Promise<Record<string, { relation: RivalryRelation; rivalryId: string }>> {
  if (!isUuid(currentUserId)) return {};
  const rows = await db
    .select()
    .from(rivalries)
    .where(or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)))
    .limit(1000);
  const out: Record<string, { relation: RivalryRelation; rivalryId: string }> = {};
  for (const row of rows) {
    const other = row.userAId === currentUserId ? row.userBId : row.userAId;
    out[other] = { relation: relationFor(row, currentUserId), rivalryId: row.id };
  }
  return out;
}
