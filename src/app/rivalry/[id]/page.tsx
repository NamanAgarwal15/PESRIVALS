import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { UploadMatchPanel } from "@/components/matches/upload-match-panel";
import { RivalryDashboard } from "@/components/dashboard/rivalry-dashboard";
import { getRivalryAnalyticsMatches } from "@/lib/career-stats";
import { getRivalryMatches } from "@/lib/match-helpers";
import { type RivalryOpponent, getRivalryForMember } from "@/lib/rivalry-helpers";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Rivalry | PESRIVALS" };

export default function RivalryPage({ params }: PageProps<"/rivalry/[id]">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <Link
        href="/home"
        className="self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to home
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <RivalryContent params={params} />
      </Suspense>
    </main>
  );
}

// Reads the session and the URL, so it streams in behind the Suspense boundary.
// src/proxy.ts runs the same membership check first so that a missing rivalry
// is a real HTTP 404; this is the check that actually guards the data.
import { PushBanner } from "@/components/push/push-banner";

async function RivalryContent({ params }: Pick<PageProps<"/rivalry/[id]">, "params">) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");

  const { id } = await params;
  const rivalry = await getRivalryForMember(session.user.id, id);
  if (!rivalry) notFound();

  const matches = await getRivalryMatches(session.user.id, rivalry.id, 200);
  const analyticsMatches = await getRivalryAnalyticsMatches(session.user.id, rivalry.id);

  return (
    <>
      <PushBanner />
      <header className="flex flex-col gap-4">
        <h1 className="sr-only">
          @{rivalry.me.username} vs @{rivalry.opponent.username}
        </h1>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <Side player={rivalry.me} label="You" />
          <span className="font-heading text-3xl font-bold text-primary uppercase">vs</span>
          <Side player={rivalry.opponent} label="Rival" />
        </div>
        <p className="text-center text-sm text-muted-foreground">
          {rivalry.matchCount} {rivalry.matchCount === 1 ? "match" : "matches"} played
        </p>
      </header>

      <RivalryDashboard
        rivalryId={rivalry.id}
        matches={analyticsMatches}
        displayMatches={matches}
        meName={rivalry.me.displayName}
        oppName={rivalry.opponent.displayName}
        opponentUsername={rivalry.opponent.username}
        uploadSlot={
          <UploadMatchPanel
            rivalryId={rivalry.id}
            myUsername={rivalry.me.username}
            opponentUsername={rivalry.opponent.username}
          />
        }
      />
    </>
  );
}

function Side({ player, label }: { player: RivalryOpponent; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 text-center">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="w-full truncate font-heading text-2xl font-semibold">
        @{player.username}
      </span>
      <span className="w-full truncate text-sm text-muted-foreground">
        {player.displayName}
      </span>
    </div>
  );
}
