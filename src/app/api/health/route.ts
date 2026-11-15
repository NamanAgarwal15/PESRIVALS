import { sql } from "drizzle-orm";
import { connection } from "next/server";

// Health check: proves the app can really reach Neon.
// The response must never contain a host, username, database name or
// connection string, so errors are swallowed and reported as a bare 500.
export async function GET() {
  // Always run at request time (never prerendered or cached).
  await connection();

  try {
    const { db } = await import("@/db");
    await db.execute(sql`SELECT 1`);
  } catch {
    return Response.json(
      { ok: false, db: false },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      ok: true,
      db: true,
      target: process.env.NODE_ENV === "development" ? "local" : "remote",
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
