import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCareerStats } from "@/lib/career-stats";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Career Stats | PESRIVALS" };

export default function StatsPage() {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <Link
        href="/home"
        className="self-start text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to home
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <StatsContent />
      </Suspense>
    </main>
  );
}

function fmt(v: number | null, digits = 1): string {
  return v === null ? "—" : v.toFixed(digits);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="font-heading text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

async function StatsContent() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");

  const stats = await getCareerStats(session.user.id);
  if (!stats) redirect("/login");

  const { overall, overallComparison, perRivalry } = stats;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-wide uppercase">Overall Career Stats</h1>
        <p className="text-sm text-muted-foreground">
          Me vs All — every confirmed match across your {stats.totalRivalries} active{" "}
          {stats.totalRivalries === 1 ? "rivalry" : "rivalries"}.
        </p>
      </header>

      {overall.played === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 py-8 text-center">
            <p className="font-heading text-2xl font-semibold tracking-wide uppercase">
              No matches logged yet
            </p>
            <p className="text-sm text-muted-foreground">
              Add match screenshots in a rivalry to build your career record.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
                <Stat label="Matches" value={String(overall.played)} />
                <Stat label="Wins" value={String(overall.wins)} />
                <Stat label="Draws" value={String(overall.draws)} />
                <Stat label="Losses" value={String(overall.losses)} />
                <Stat label="Win %" value={fmt(overall.winPct)} />
                <Stat label="Goals" value={`${overall.goalsFor}–${overall.goalsAgainst}`} />
                <Stat label="GD" value={`${overall.goalDiff > 0 ? "+" : ""}${overall.goalDiff}`} />
                <Stat label="Avg goals/game" value={fmt(overall.avgGoalsFor, 2)} />
                <Stat label="Clean sheets" value={String(overall.cleanSheets)} />
                <Stat label="Best win run" value={`W${overall.longestWinStreak}`} />
              </div>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                {(
                  [
                    [overall.wins, "bg-win"],
                    [overall.draws, "bg-draw"],
                    [overall.losses, "bg-loss"],
                  ] as const
                ).map(([n, cls]) => (
                  <div key={cls} className={cls} style={{ width: `${(n / overall.played) * 100}%` }} />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Averages Per Game (All Rivals)</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-sm tabular-nums md:grid-cols-4">
              {overallComparison.stats.map((s) => (
                <div key={s.key} className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground uppercase">{s.label}</span>
                  <span className="font-semibold">
                    {s.key === "possession" ? fmt(s.mine.avg, 0) : fmt(s.mine.avg)}
                  </span>
                </div>
              ))}
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Shot accuracy %</span>
                <span className="font-semibold">{fmt(overallComparison.shotAccuracy.mine)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Goal conversion %</span>
                <span className="font-semibold">{fmt(overallComparison.goalConversion.mine)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Pass accuracy %</span>
                <span className="font-semibold">{fmt(overallComparison.passAccuracy.mine)}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Per-Rival Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {perRivalry.map((r) => (
                <Link
                  key={r.rivalryId}
                  href={`/rivalry/${r.rivalryId}`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-secondary/50 p-3 text-sm transition-colors hover:bg-secondary"
                >
                  <span className="min-w-0 truncate font-medium">
                    @{r.opponentUsername}
                    <span className="ml-2 text-muted-foreground">{r.opponentDisplayName}</span>
                  </span>
                  <span className="flex flex-wrap gap-x-3 tabular-nums">
                    <span>
                      <span className="text-win">{r.summary.wins}W</span>{" "}
                      <span className="text-draw">{r.summary.draws}D</span>{" "}
                      <span className="text-loss">{r.summary.losses}L</span>
                    </span>
                    <span className="text-muted-foreground">
                      {r.summary.goalsFor}–{r.summary.goalsAgainst}
                    </span>
                    <span className="text-muted-foreground">{fmt(r.summary.winPct)}%</span>
                    <span className="text-muted-foreground">{r.summary.played}m</span>
                  </span>
                </Link>
              ))}
            </CardContent>
          </Card>

        </>
      )}
    </>
  );
}

