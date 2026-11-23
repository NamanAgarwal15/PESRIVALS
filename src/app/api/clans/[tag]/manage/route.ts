import { z } from "zod";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { disbandClan, inviteToClan, kickMember, leaveClan, setMemberRole, transferLeadership } from "@/lib/clans";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), username: z.string().max(20) }),
  z.object({ action: z.literal("kick"), username: z.string().max(20) }),
  z.object({ action: z.literal("role"), username: z.string().max(20), role: z.enum(["officer", "member"]) }),
  z.object({ action: z.literal("transfer"), username: z.string().max(20) }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("disband") }),
]);

// POST { action, ... } -> roster management. Permissions are decided on the server from your membership.
export async function POST(request: Request, context: RouteContext<"/api/clans/[tag]/manage">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const parsed = body.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "Invalid request." }, 400);
    const rl = await consumeRateLimit(`clan-manage:${who.userId}`, LIMITS.clanManage.max, LIMITS.clanManage.windowMinutes);
    if (!rl.ok) return json({ ok: false, error: "Too many changes. Try again later." }, 429);
    const { tag } = await context.params;
    const a = parsed.data;
    const res =
      a.action === "invite" ? await inviteToClan(who.userId, tag, a.username)
      : a.action === "kick" ? await kickMember(who.userId, tag, a.username)
      : a.action === "role" ? await setMemberRole(who.userId, tag, a.username, a.role)
      : a.action === "transfer" ? await transferLeadership(who.userId, tag, a.username)
      : a.action === "disband" ? await disbandClan(who.userId, tag)
      : await leaveClan(who.userId);
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "clan_manage", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not do that." }, 503);
  }
}
