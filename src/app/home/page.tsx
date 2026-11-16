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
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth-actions";
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

  return (
    <>
      <header className="flex items-center justify-between gap-4">
        <h1 className="min-w-0 truncate text-4xl font-bold tracking-wide">
          Hi @{session.user.username}
        </h1>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="lg" className="h-10 px-4">
            Log out
          </Button>
        </form>
      </header>
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
