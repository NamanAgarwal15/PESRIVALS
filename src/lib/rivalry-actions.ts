"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { sendPushToUser } from "@/lib/push";
import { z } from "zod";
import { auth } from "@/auth";
import {
  type RivalryMutationResult,
  type RivalryRelation,
  type UserSearchResult,
  cancelRivalryRequest,
  normalizeUsernameQuery,
  respondToRivalryRequest,
  searchUsersByUsername,
  sendRivalryRequest,
} from "@/lib/rivalry-helpers";

// Every action re-reads the session itself; nothing from the client is
// trusted to say who is acting.
async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  return session.user.id;
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

const idSchema = z.uuid();
const decisionSchema = z.enum(["accept", "decline"]);

export type SearchState = {
  /** The query as typed, echoed back into the input. */
  query?: string;
  results?: UserSearchResult[];
  error?: string;
};

export async function searchUsersAction(
  _prev: SearchState,
  formData: FormData,
): Promise<SearchState> {
  const userId = await requireUserId();
  const query = field(formData, "query").slice(0, 40);

  if (!normalizeUsernameQuery(query)) {
    return {
      query,
      error: "Type at least 2 characters: letters, numbers or underscores.",
    };
  }
  return { query, results: await searchUsersByUsername(userId, query) };
}

export type RivalryActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  relation?: RivalryRelation;
  rivalryId?: string;
};

function toState(result: RivalryMutationResult, message: string): RivalryActionState {
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/home");
  return {
    ok: true,
    message: result.autoAccepted ? "They had already challenged you. Rivalry on!" : message,
    relation: result.relation,
    rivalryId: result.rivalryId,
  };
}

export async function sendRivalryRequestAction(
  _prev: RivalryActionState,
  formData: FormData,
): Promise<RivalryActionState> {
  const userId = await requireUserId();
  const target = idSchema.safeParse(field(formData, "targetUserId"));
  if (!target.success) return { ok: false, error: "User not found" };

  const result = await sendRivalryRequest(userId, target.data);
  if (result.ok) {
    const targetId = target.data;
    after(() =>
      sendPushToUser(targetId, {
        title: "New rivalry challenge",
        body: "Someone challenged you. Open your leaderboard to accept.",
        url: "/leaderboard",
        tag: "invite",
      }),
    );
  }
  return toState(result, "Challenge sent");
}

export async function respondToRivalryRequestAction(
  _prev: RivalryActionState,
  formData: FormData,
): Promise<RivalryActionState> {
  const userId = await requireUserId();
  const rivalryId = idSchema.safeParse(field(formData, "rivalryId"));
  const decision = decisionSchema.safeParse(field(formData, "decision"));
  if (!rivalryId.success || !decision.success) {
    return { ok: false, error: "Request not found" };
  }

  return toState(
    await respondToRivalryRequest(userId, rivalryId.data, decision.data),
    decision.data === "accept" ? "Rivalry on!" : "Request declined",
  );
}

export async function cancelRivalryRequestAction(
  _prev: RivalryActionState,
  formData: FormData,
): Promise<RivalryActionState> {
  const userId = await requireUserId();
  const rivalryId = idSchema.safeParse(field(formData, "rivalryId"));
  if (!rivalryId.success) return { ok: false, error: "Request not found" };

  return toState(await cancelRivalryRequest(userId, rivalryId.data), "Request cancelled");
}
