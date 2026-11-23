import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { createClanWar } from "@/lib/clan-wars";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { getMembership } from "@/lib/clans";
import { securityLog } from "@/lib/security-log";

// POST { defenderTag, seriesSize, pairings:[{mine, theirs}] } -> your clan challenges another (officers only).
export async function POST(request: Request, context: RouteContext<"/api/clans/[tag]/wars">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const { tag } = await context.params;
    const mine = await getMembership(who.userId);
    if (!mine || mine.tag !== tag.toUpperCase()) return json({ ok: false, error: "Clan not found." }, 404);
    const res = await createClanWar(who.userId, await readJson(request, 8192));
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true, warId: res.warId }, 201);
  } catch (err) {
    securityLog("request_failed", { route: "clan_war_create", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that challenge." }, 503);
  }
}
