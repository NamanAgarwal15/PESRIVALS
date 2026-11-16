import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Optimistic, cookie-only redirects so signed-out visitors get a real HTTP
// redirect instead of a flash of the page shell. The pages and server
// actions still check the session themselves; this is not the security layer.
export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;
  const user = req.auth?.user;
  const to = (path: string) => NextResponse.redirect(new URL(path, req.nextUrl));

  if (pathname === "/home") {
    if (!user?.id) return to("/login");
    if (!user.onboarded) return to("/onboarding");
  } else if (pathname === "/onboarding") {
    if (!user?.id) return to("/login");
    if (user.onboarded) return to("/home");
  } else if (pathname === "/login" || pathname === "/signup") {
    if (user?.id) return to(user.onboarded ? "/home" : "/onboarding");
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/home", "/onboarding", "/login", "/signup"],
};
