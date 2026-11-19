import { auth } from "@/auth";
import { buildUserExport } from "@/lib/account";
import { securityLog } from "@/lib/security-log";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ ok: false, error: "Log in first." }, { status: 401 });
  try {
    const data = await buildUserExport(session.user.id);
    if (!data) return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="pesrivals-${data.profile.username}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    securityLog("request_failed", { route: "export", error: err instanceof Error ? err.name : "unknown" }, "error");
    return Response.json({ ok: false, error: "Could not build the export." }, { status: 503 });
  }
}
