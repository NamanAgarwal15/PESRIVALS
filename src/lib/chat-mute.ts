// Chat-only mute. While users.chat_muted_until is in the future the account cannot SEND
// chat messages (1v1, lobby, clan). Everything else keeps working: rivalries, challenges,
// match uploads, reading chat, and reporting. Checked in the database on every send.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export const MUTE_PRESETS = ["24h", "7d", "permanent", "unmute"] as const;
export type MutePreset = (typeof MUTE_PRESETS)[number];

/** "Permanent" is a far-future timestamp, so there is a single code path for every mute. */
export const PERMANENT_MUTE_UNTIL = new Date("2100-01-01T00:00:00.000Z");

export function muteUntil(preset: MutePreset, now: Date = new Date()): Date | null {
  switch (preset) {
    case "24h": return new Date(now.getTime() + 24 * 3_600_000);
    case "7d": return new Date(now.getTime() + 7 * 86_400_000);
    case "permanent": return PERMANENT_MUTE_UNTIL;
    case "unmute": return null;
  }
}

export const MUTED_MESSAGE = "Chat is switched off for your account right now. You can still play and challenge as normal.";

export async function isChatMuted(userId: string): Promise<boolean> {
  const [row] = await db.select({ until: users.chatMutedUntil }).from(users).where(eq(users.id, userId));
  return Boolean(row?.until && row.until.getTime() > Date.now());
}
