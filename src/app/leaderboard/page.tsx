import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { AuthAwareBack } from "@/components/nav/back-link";
import { LeaderboardAction } from "@/components/rivalries/leaderboard-action";
import { IncomingRequestsSection, SentRequestsSection } from "@/components/rivalries/rivalry-sections";
import { getRelationMap, getUserRivalries } from "@/lib/rivalry-helpers";
import { getSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";
import { getCachedLeaderboard } from "@/lib/leaderboard-cache";
import { searchPlayers } from "@/lib/player-profile";

export const metadata: Metadata = { title: "Leaderboard | PESRIVALS" };

export default function LeaderboardPage({ searchParams }: PageProps<"/leaderboard">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <AuthAwareBack />
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-wide uppercase">Global Leaderboard</h1>
        <p className="text-sm text-muted-foreground">
          Aggregated career stats across every rivalry — never individual head-to-head scores. Challenge any player to start a rivalry.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <LeaderboardContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const FORM_COLOR: Record<string, string> = { W: "text-win", D: "text-draw", L: "text-loss" };

async function LeaderboardContent({
  searchParams,
}: Pick<PageProps<"/leaderboard">, "searchParams">) {
  await connection();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const found = q.trim().length >= 2 ? await searchPlayers(q) : [];
  const [rows, session] = await Promise.all([getCachedLeaderboard(), getSession()]);
  const me = session?.user?.id;
  const relations = me ? await getRelationMap(me) : {};
  const requests = me ? await getUserRivalries(me) : null;

  if (!rows.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No players on the board yet — log some matches to appear here.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    <Card>
      <CardContent className="flex flex-col gap-3">
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="Find any player by username or name"
            className="h-10 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
          />
          <button type="submit" className="h-10 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground">
            Search
          </button>
        </form>
        {q.trim().length >= 2 ? (
          found.length ? (
            <div className="flex flex-col gap-1">
              {found.map((p) => (
                <Link key={p.username} href={me ? `/player/${p.username}` : "/login"} className="text-sm hover:underline">
                  @{p.username} <span className="text-muted-foreground">{p.displayName}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No players found.</p>
          )
        ) : null}
      </CardContent>
    </Card>
    {requests ? (
      <>
        <IncomingRequestsSection requests={requests.incomingRequests} />
        <SentRequestsSection requests={requests.sentRequests} />
      </>
    ) : null}
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="hidden grid-cols-[3rem_1fr_3rem_6rem_3.5rem_4rem_3rem_4rem_4rem_4rem_5rem_8rem] gap-2 border-b pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:grid">
          <span>#</span>
          <span>Player</span>
          <span className="text-right">M</span>
          <span className="text-center">W-D-L</span>
          <span className="text-right">Win %</span>
          <span className="text-right">Goals</span>
          <span className="text-right">GD</span>
          <span className="text-right">Poss</span>
          <span className="text-right">Pass %</span>
          <span className="text-right">CS</span>
          <span className="text-center">Form</span>
          <span className="text-right">Rivalry</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.username}
            className="grid grid-cols-2 items-center gap-2 border-b border-border/50 py-2 text-sm tabular-nums last:border-0 lg:grid-cols-[3rem_1fr_3rem_6rem_3.5rem_4rem_3rem_4rem_4rem_4rem_5rem_8rem]"
          >
            <span className="font-heading text-lg font-bold text-muted-foreground">
              {r.rank}
            </span>
            <span className="min-w-0 truncate font-medium">
              {me ? (
                <Link href={`/player/${r.username}`} className="hover:underline">
                  @{r.username}
                </Link>
              ) : (
                <>@{r.username}</>
              )}
              <span className="ml-2 hidden text-muted-foreground md:inline">
                {r.displayName}
              </span>
            </span>
            <span className="text-right">{r.summary.played}</span>
            <span className="text-center">
              <span className="text-win">{r.summary.wins}</span>–
              <span className="text-draw">{r.summary.draws}</span>–
              <span className="text-loss">{r.summary.losses}</span>
            </span>
            <span className="text-right">{r.summary.winPct.toFixed(1)}</span>
            <span className="text-right">
              {r.summary.goalsFor}–{r.summary.goalsAgainst}
            </span>
            <span className="text-right">
              {r.summary.goalDiff > 0 ? "+" : ""}
              {r.summary.goalDiff}
            </span>
            <span className="text-right">
              {r.avgPossession === null ? "—" : `${r.avgPossession.toFixed(0)}%`}
            </span>
            <span className="text-right">
              {r.passAccuracy === null ? "—" : `${r.passAccuracy.toFixed(1)}`}
            </span>
            <span className="text-right">{r.summary.cleanSheets}</span>
            <span className="text-center font-semibold">
              {r.summary.last5Form
                .map((o) => (
                  <span key={o} className={FORM_COLOR[o[0].toUpperCase()]}>
                    {o[0].toUpperCase()}
                  </span>
                ))
                .reduce<React.ReactNode[]>((acc, el, i) => {
                  if (i > 0) acc.push(" ");
                  acc.push(el);
                  return acc;
                }, [])}
            </span>
            <span className="col-span-2 flex justify-end lg:col-span-1">
              {me && me !== r.userId ? (
                <span className="flex items-center gap-3">
                  <Link href={`/chat/${r.username}`} className="text-xs text-primary underline-offset-4 hover:underline">
                    Message
                  </Link>
                  <LeaderboardAction
                    targetUserId={r.userId}
                    relation={relations[r.userId]?.relation ?? "none"}
                    rivalryId={relations[r.userId]?.rivalryId}
                  />
                </span>
              ) : me === r.userId ? (
                <span className="text-xs text-muted-foreground">You</span>
              ) : (
                <Link href="/login" className="text-xs text-primary underline-offset-4 hover:underline">Log in to challenge</Link>
              )}
            </span>
          </div>
        ))}
        <p className="pt-2 text-center text-xs text-muted-foreground">
          Read the{" "}
          <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
            privacy policy
          </Link>{" "}
          to see exactly what is public.
        </p>
      </CardContent>
    </Card>
    </>
  );
}
