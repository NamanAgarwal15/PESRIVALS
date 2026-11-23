import { z } from "zod";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { setMessageBlock } from "@/lib/dm-chat";
import { securityLog } from "@/lib/security-log";

const bodySchema = z.object({ blocked: z.boolean() });

// PUT { blocked: boolean }: "Block Msgs Only (Keep Challenge Open)". Messages only; challenges are untouched.
export async function PUT(request: Request, context: RouteContext<"/api/chat/[username]/block">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ ok: false, error: "Invalid request." }, 400);
    const { username } = await context.params;
    const res = await setMessageBlock(who.userId, decodeURIComponent(username), parsed.data.blocked);
    if (!res.ok) return json({ ok: false, error: res.error }, 404);
    return json({ ok: true, blocked: res.blocked }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "chat_block", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not update that." }, 503);
  }
}
