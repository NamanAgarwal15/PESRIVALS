import { connection } from "next/server";
import { auth } from "@/auth";

/**
 * Reads the current session in a Server Component. Call it inside <Suspense>.
 *
 * Auth.js generates random values (a CSRF token) while reading the session,
 * which Next.js refuses to prerender. `connection()` marks everything after
 * it as request-time only, so the session never ends up in a prerendered shell.
 */
export async function getSession() {
  await connection();
  return auth();
}
