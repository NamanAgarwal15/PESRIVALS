import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import {
  ActiveRivalriesSection,
  ChallengeSection,
  IncomingRequestsSection,
  SentRequestsSection,
} from "@/components/rivalries/rivalry-sections";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { logoutAction, linkGoogleAction } from "@/lib/auth-actions";
import { SettingsCard } from "@/components/account/settings-card";
import { getAnnouncement } from "@/lib/admin";
import { getAccountSecurity, isGoogleEnabled } from "@/lib/auth-helpers";
import { getUserRivalries } from "@/lib/rivalry-helpers";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Home | PESRIVALS" };

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col gap-8">
      <Suspense fallback={<HomeFallback />}>
        <HomeContent />
      </Suspense>
    </main>
  );
}

function HomeFallback() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

// Reads the session, so it has to stream in behind the Suspense boundary.
async function HomeContent() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");

  const { activeRivalries, incomingRequests, sentRequests } = await getUserRivalries(
    session.user.id,
  );
  const security = await getAccountSecurity(session.user.id);
  const announcement = await getAnnouncement();

  return (
    <>
      {announcement ? (
        <p role="status" className="rounded-lg border border-primary/40 bg-primary/10 px-4 py-2 text-sm">
          {announcement}
        </p>
      ) : null}
      <header className="flex items-center justify-between gap-4">
        <h1 className="min-w-0 truncate text-4xl font-bold tracking-wide">
          Hi @{session.user.username}
        </h1>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/leaderboard" className="text-muted-foreground hover:text-foreground">Leaderboard</Link>
          {session.user.role === "admin" ? (
            <Link href="/admin" className="text-xs text-muted-foreground/70 hover:text-foreground">Admin</Link>
          ) : null}
        </nav>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="lg" className="h-10 px-4">
            Log out
          </Button>
        </form>
      </header>

      {security ? (
        <Card>
          <CardHeader>
            <CardTitle>Account Security &amp; Google Link</CardTitle>
            <CardDescription>
              Recovery channels for your account. Link Google so you can always get back in.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-1 text-sm">
              <span>
                <span className="text-muted-foreground">Email: </span>
                <span className="font-medium">{security.email ?? "not set"}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Phone: </span>
                <span className="font-medium">{security.phone ?? "not set"}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Google: </span>
                <span className={security.googleLinked ? "font-medium text-win" : "font-medium"}>
                  {security.googleLinked ? "linked" : "not linked"}
                </span>
              </span>
            </div>
            {security.googleLinked ? null : isGoogleEnabled() ? (
              <form action={linkGoogleAction}>
                <Button type="submit" size="lg" className="h-10 px-4">
                  Link Google Account
                </Button>
              </form>
            ) : (
              <p className="max-w-xs text-xs text-muted-foreground">
                Google sign-in is not configured on this deployment, so linking is unavailable.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
      {security ? (
        <SettingsCard
          email={security.email}
          phone={security.phone}
          publicLeaderboard={security.publicLeaderboard}
        />
      ) : null}
      <Link
        href="/leaderboard"
        className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-colors hover:bg-secondary"
      >
        <span className="font-heading text-lg font-semibold tracking-wide uppercase">Global Leaderboard</span>
        <span className="text-primary" aria-hidden>→</span>
      </Link>
      <Link
        href="/stats"
        className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-colors hover:bg-secondary"
      >
        <span className="flex flex-col">
          <span className="font-heading text-lg font-semibold tracking-wide uppercase">
            Overall Career Stats (Me vs All)
          </span>
          <span className="text-sm text-muted-foreground">
            W-D-L, goals and per-game averages across every rivalry
          </span>
        </span>
        <span className="text-primary" aria-hidden>
          →
        </span>
      </Link>
      <IncomingRequestsSection requests={incomingRequests} />
      <ChallengeSection />
      <SentRequestsSection requests={sentRequests} />
      <ActiveRivalriesSection rivalries={activeRivalries} />
    </>
  );
}
