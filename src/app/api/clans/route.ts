import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { createClan, listClans } from "@/lib/clans";
import { securityLog } from "@/lib/security-log";

// GET ?q= -> public clan directory (max 30).
export async function GET(request: Request) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  return json({ ok: true, clans: await listClans(new URL(request.url).searchParams.get("q")) }, 200);
}

// POST { name, tag, description? } -> creates a clan with you as leader.
export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  if (!who.onboarded) return json({ ok: false, error: "Finish setting up your account first." }, 403);
  try {
    const res = await createClan(who.userId, await readJson(request));
    if (!res.ok) return json({ ok: false, error: res.error }, CLAN_STATUS[res.code]);
    return json({ ok: true, tag: res.tag }, 201);
  } catch (err) {
    securityLog("request_failed", { route: "clan_create", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not create the clan." }, 503);
  }
}
