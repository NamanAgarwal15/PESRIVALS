import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isActiveRivalryMember } from "@/lib/rivalry-helpers";

const RIVALRY_PREFIX = "/rivalry/";

// Optimistic, cookie-only redirects so signed-out visitors get a real HTTP
// redirect instead of a flash of the page shell. The pages and server
// actions still check the session themselves; this is not the security layer.
export const proxy = auth(async (req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  const to = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl));

  if (pathname === "/home" || pathname === "/stats") {
    if (!user?.id) return to("/login");
    if (!user.onboarded) return to("/onboarding");
  } else if (pathname === "/onboarding") {
    if (!user?.id) return to("/login");
    if (user.onboarded) return to("/home");
  } else if (pathname === "/login" || pathname === "/signup") {
    if (user?.id) return to(user.onboarded ? "/home" : "/onboarding");
  } else if (pathname.startsWith(RIVALRY_PREFIX)) {
    if (!user?.id) return to("/login");
    if (!user.onboarded) return to("/onboarding");
    // A page that streams cannot change its status code once the shell is
    // sent, so the 404 for "not found / not active / not yours" has to be
    // decided here. One primary-key lookup; the page repeats the check.
    const rivalryId = pathname.slice(RIVALRY_PREFIX.length);
    if (!(await isActiveRivalryMember(user.id, rivalryId))) {
      // No route matches this path, so Next.js serves its 404 page.
      return NextResponse.rewrite(new URL("/_rivalry-not-found", req.nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/home", "/onboarding", "/login", "/signup", "/stats", "/rivalry/:path*"],
};
