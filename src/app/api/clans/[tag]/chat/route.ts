import { after } from "next/server";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { getClanMessages, maybePruneClanChat, sendClanMessage } from "@/lib/clans";
import { LIMITS, clientIpFromHeaders, consumeRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

// GET -> newest 50 messages of YOUR clan's private chat. Non-members get a plain 404.
export async function GET(request: Request, context: RouteContext<"/api/clans/[tag]/chat">) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  const rl = await consumeRateLimit(`clan-read:${who.userId}`, LIMITS.clanChatRead.max, LIMITS.clanChatRead.windowMinutes);
  if (!rl.ok) return json({ ok: false, error: "Too many refreshes. Wait a moment." }, 429);
  try {
    const { tag } = await context.params;
    const res = await getClanMessages(who.userId, tag);
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true, messages: res.messages }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "clan_chat_get", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Clan chat is unavailable right now." }, 503);
  }
}

// POST { body } -> posts to your clan's chat after the deterministic filter.
export async function POST(request: Request, context: RouteContext<"/api/clans/[tag]/chat">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const payload = (await readJson(request)) as { body?: unknown } | null;
    const { tag } = await context.params;
    const res = await sendClanMessage(who.userId, tag, payload?.body, clientIpFromHeaders(request.headers));
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    after(() => maybePruneClanChat());
    return json({ ok: true, message: res.message }, 201);
  } catch (err) {
    securityLog("request_failed", { route: "clan_chat_post", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that message." }, 503);
  }
}
