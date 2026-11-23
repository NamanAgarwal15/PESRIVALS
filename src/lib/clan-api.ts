// Shared glue for the clan API routes: status mapping and a bounded JSON body reader.
import type { ClanErrorCode } from "@/lib/clans";

export const CLAN_STATUS: Record<ClanErrorCode, number> = {
  not_found: 404, forbidden: 403, invalid: 400, conflict: 409, rate_limited: 429, filtered: 422, muted: 403,
};

export async function readJson(request: Request, maxBytes = 4096): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  return request.json().catch(() => null);
}
