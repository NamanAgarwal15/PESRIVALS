import { apiUser, noStoreJson } from "@/lib/api-guard";
import { buildUserExport } from "@/lib/account";
import { securityLog } from "@/lib/security-log";

export async function GET(request: Request) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  try {
    const data = await buildUserExport(who.userId);
    if (!data) return noStoreJson({ ok: false, error: "Not found" }, 404);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="pesrivals-${data.profile.username}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    securityLog("request_failed", { route: "export", error: err instanceof Error ? err.name : "unknown" }, "error");
    return noStoreJson({ ok: false, error: "Could not build the export." }, 503);
  }
}
