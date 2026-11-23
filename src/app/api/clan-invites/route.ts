import { z } from "zod";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { listMyInvites, respondToInvite } from "@/lib/clans";
import { securityLog } from "@/lib/security-log";

const body = z.object({ inviteId: z.uuid(), accept: z.boolean() });

// GET -> your own pending invites.
export async function GET(request: Request) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  return json({ ok: true, invites: await listMyInvites(who.userId) }, 200);
}

// POST { inviteId, accept } -> only the invited player can answer.
export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const parsed = body.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "Invalid request." }, 400);
    const res = await respondToInvite(who.userId, parsed.data.inviteId, parsed.data.accept);
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true, tag: res.tag ?? null }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "clan_invite", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not do that." }, 503);
  }
}
