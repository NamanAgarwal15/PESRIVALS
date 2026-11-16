"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { type SaveMatchResult, saveMatchForUser } from "@/lib/match-helpers";
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
  }
  return result;
}
