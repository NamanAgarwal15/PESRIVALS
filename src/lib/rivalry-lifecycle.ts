// What happens to a player's rivalries when their account is deleted or suspended.
// Framework-free. Closing them stops "ghost opponent" farming: nobody can keep saving
// matches against someone who can no longer see, confirm or dispute them.

import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { rivalries } from "@/db/schema";

/**
 * Active rivalries become `archived` (remembering who caused it, so an unsuspend can restore them);
 * pending challenges involving the user are declined. Matches are kept, they just stop counting.
 */
export async function archiveRivalriesForUser(userId: string): Promise<void> {
  const involved = or(eq(rivalries.userAId, userId), eq(rivalries.userBId, userId));
  await db.batch([
    db.update(rivalries).set({ status: "archived", archivedBy: userId }).where(and(eq(rivalries.status, "active"), involved)),
    db.update(rivalries).set({ status: "declined" }).where(and(eq(rivalries.status, "pending"), involved)),
  ]);
}

/** Undoes the archive after an unsuspend, unless the other player is suspended too. */
export async function restoreRivalriesForUser(userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE rivalries r SET status = 'active', archived_by = NULL
    WHERE r.archived_by = ${userId}::uuid AND r.status = 'archived'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.suspended AND (u.id = r.user_a_id OR u.id = r.user_b_id))`);
}
