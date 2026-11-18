import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/nav/back-link";
import { CopyButton } from "@/components/profile/copy-button";
import { LeaderboardAction } from "@/components/rivalries/leaderboard-action";
import { Card, CardContent } from "@/components/ui/card";
import { getPlayerProfile } from "@/lib/player-profile";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Player | PESRIVALS" };

export default function PlayerPage({ params }: PageProps<"/player/[username]">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/leaderboard">← Back to Leaderboard</BackLink>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <PlayerContent params={params} />
      </Suspense>
    </main>
  );
}

async function PlayerContent({ params }: Pick<PageProps<"/player/[username]">, "params">) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { username } = await params;
  const profile = await getPlayerProfile(
    { id: session.user.id, role: session.user.role },
    decodeURIComponent(username),
  );
  if (!profile) notFound();

  const { user, career, relation, rivalryId, isSelf } = profile;
  const s = career.summary;
  const stats: [string, string][] = [
    ["Matches", String(s.played)],
    ["Wins", String(s.wins)],
    ["Draws", String(s.draws)],
    ["Losses", String(s.losses)],
    ["Win %", s.played ? `${s.winPct.toFixed(1)}%` : "—"],
    ["Goals", `${s.goalsFor}–${s.goalsAgainst}`],
  ];

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-4xl font-bold tracking-wide">{user.displayName}</h1>
          <p className="text-muted-foreground">@{user.username}</p>
          {user.efootballId ? (
            <p className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">eFootball ID</span>
              <span className="font-medium">{user.efootballId}</span>
              <CopyButton value={user.efootballId} />
            </p>
          ) : null}
        </div>
        {isSelf ? (
          <span className="text-sm text-muted-foreground">This is you</span>
        ) : (
          <LeaderboardAction
            targetUserId={user.id}
            relation={relation}
            rivalryId={rivalryId ?? undefined}
          />
        )}
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
              <span className="font-heading text-2xl font-bold tabular-nums">{value}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      {profile.canSeeRivalries ? (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-2xl font-semibold tracking-wide uppercase">Rivalries</h2>
            {profile.rivalries.length ? (
              profile.rivalries.map((r) => (
                <Card key={r.rivalryId} size="sm">
                  <CardContent className="flex items-center justify-between gap-3">
                    <Link
                      href={`/player/${r.opponentUsername}`}
                      className="truncate font-medium hover:underline"
                    >
                      vs @{r.opponentUsername}
                    </Link>
                    <span className="text-sm tabular-nums">
                      <span className="text-win">{r.wins}</span>–
                      <span className="text-draw">{r.draws}</span>–
                      <span className="text-loss">{r.losses}</span>
                      <span className="ml-2 text-muted-foreground">({r.played})</span>
                    </span>
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No rivalries with matches yet.</p>
            )}
          </section>
          {profile.recentMatches.length ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-2xl font-semibold tracking-wide uppercase">Recent matches</h2>
              <Card>
                <CardContent className="flex flex-col gap-2 text-sm">
                  {profile.recentMatches.map((m) => (
                    <div key={m.id} className="flex flex-wrap justify-between gap-2 border-b border-border/50 pb-2 last:border-0">
                      <span>
                        @{m.aUser} <b className="tabular-nums">{m.aGoals}–{m.bGoals}</b> @{m.bUser}
                      </span>
                      <span className="text-muted-foreground">
                        #{m.matchNo}
                        {m.playedAt ? ` · ${m.playedAt}` : ""}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </section>
          ) : null}
        </>
      ) : (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            This player keeps their rivalry match logs private.
            {relation === "active" && rivalryId ? (
              <>
                {" "}
                You can still{" "}
                <Link href={`/rivalry/${rivalryId}`} className="text-primary underline-offset-4 hover:underline">
                  open your rivalry
                </Link>
                .
              </>
            ) : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
