import { z } from "zod";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { respondToClanWar } from "@/lib/clan-wars";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { securityLog } from "@/lib/security-log";

const body = z.object({ action: z.enum(["accept", "decline", "cancel"]) });

// POST { action } -> accept / decline (challenged clan officers) or cancel (challenging clan officers).
export async function POST(request: Request, context: RouteContext<"/api/clan-wars/[id]">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const parsed = body.safeParse(await readJson(request));
    if (!parsed.success) return json({ ok: false, error: "Invalid request." }, 400);
    const { id } = await context.params;
    const res = await respondToClanWar(who.userId, id, parsed.data.action);
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "clan_war_respond", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not do that." }, 503);
  }
}
