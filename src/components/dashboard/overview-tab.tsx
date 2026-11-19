import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MatchList } from "@/components/matches/match-list";
import type { RivalryMatch } from "@/lib/match-helpers";
import type { computeRivalryAnalytics } from "@/lib/rivalry-analytics";
import { fmt, FORM_CLASS, Stat } from "@/components/dashboard/dashboard-parts";

export function OverviewTab({
  summary,
  hosting,
  comparison,
  records,
  meName,
  oppName,
  opponentUsername,
  filteredDisplay,
  uploadSlot,
}: {
  summary: ReturnType<typeof computeRivalryAnalytics>["summary"];
  hosting: ReturnType<typeof computeRivalryAnalytics>["hosting"];
  comparison: ReturnType<typeof computeRivalryAnalytics>["comparison"];
  records: ReturnType<typeof computeRivalryAnalytics>["records"];
  meName: string;
  oppName: string;
  opponentUsername: string;
  filteredDisplay: RivalryMatch[];
  uploadSlot?: React.ReactNode;
}) {
  const total = summary.wins + summary.draws + summary.losses || 1;
  return (
    <div className="flex flex-col gap-6">
      {/* Top Bento row: H2H hero + hosting split & records */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-5">
          <CardHeader>
            <CardTitle>Head-to-Head</CardTitle>
            <CardDescription>
              The overall record from your point of view ({meName} vs {oppName}).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 p-3.5 md:p-6">
            <p className="text-center font-heading text-3xl font-bold tabular-nums">
              <span className="text-win">{summary.wins}W</span>{" "}
              <span className="text-muted-foreground">–</span>{" "}
              <span className="text-draw">{summary.draws}D</span>{" "}
              <span className="text-muted-foreground">–</span>{" "}
              <span className="text-loss">{summary.losses}L</span>
            </p>
            <p className="text-center text-sm text-muted-foreground">
              {meName} <span className="mx-1 text-muted-foreground">vs</span> {oppName} ·{" "}
              {summary.played} {summary.played === 1 ? "match" : "matches"}
            </p>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="bg-win" style={{ width: `${(summary.wins / total) * 100}%` }} />
              <div className="bg-draw" style={{ width: `${(summary.draws / total) * 100}%` }} />
              <div className="bg-loss" style={{ width: `${(summary.losses / total) * 100}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Win %" value={fmt(summary.winPct)} />
              <Stat
                label="Goals (GF–GA)"
                value={`${summary.goalsFor}–${summary.goalsAgainst}`}
              />
              <Stat
                label="GD"
                value={`${summary.goalDiff > 0 ? "+" : ""}${summary.goalDiff}`}
              />
              <Stat label="Avg goals/game" value={fmt(summary.avgGoalsFor, 2)} />
              <Stat label="Streak" value={summary.currentStreak ?? "—"} />
              <Stat label="Best win run" value={`W${summary.longestWinStreak}`} />
              <Stat label="Clean sheets" value={String(summary.cleanSheets)} />
              <Stat
                label="Biggest win"
                value={
                  summary.biggestWin
                    ? `${summary.biggestWin.myGoals}–${summary.biggestWin.opponentGoals}`
                    : "—"
                }
              />
              <Stat label="Most goals" value={String(summary.mostGoalsInGame?.goals ?? "—")} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs tracking-wide text-muted-foreground uppercase">Form</span>
              {summary.last5Form.map((o, i) => (
                <span
                  key={i}
                  className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold ${FORM_CLASS[o]}`}
                >
                  {o[0].toUpperCase()}
                </span>
              ))}
              <span className="ml-1 text-xs text-muted-foreground">(newest first)</span>
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6 lg:col-span-7">
          <Card>
            <CardHeader>
              <CardTitle>When Hosting</CardTitle>
              <CardDescription>
                Who hosted matters — your record from each seat of the rivalry.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="grid grid-cols-5 gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <span>Hosted by</span>
                <span className="text-right">P</span>
                <span className="text-right">My W</span>
                <span className="text-right">D</span>
                <span className="text-right">{oppName} W</span>
              </div>
              {hosting.rows.map((row, i) => (
                <div
                  key={row.label}
                  className="grid grid-cols-5 items-center gap-2 text-sm tabular-nums"
                >
                  <span className="truncate font-medium">
                    {i === 0 ? "Hosted by Me" : `Hosted by @${opponentUsername}`}
                  </span>
                  <span className="text-right">{row.played}</span>
                  <span className="text-right text-win">{row.myWins}</span>
                  <span className="text-right text-draw">{row.draws}</span>
                  <span className="text-right text-loss">{row.opponentWins}</span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Win % — me hosting {fmt(hosting.rows[0].winPct)}% · {oppName} hosting{" "}
                {fmt(hosting.rows[1].winPct)}%
                {hosting.unattributed > 0
                  ? ` · ${hosting.unattributed} match(es) with no host recorded`
                  : ""}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Match Records</CardTitle>
              <CardDescription>The standout moments of this rivalry.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Biggest win</span>
                <span className="font-semibold tabular-nums">
                  {summary.biggestWin
                    ? `#${summary.biggestWin.matchNo}: ${summary.biggestWin.myGoals}–${summary.biggestWin.opponentGoals}`
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">
                  Most goals in a game
                </span>
                <span className="font-semibold tabular-nums">
                  {summary.mostGoalsInGame
                    ? `#${summary.mostGoalsInGame.matchNo}: ${summary.mostGoalsInGame.goals}`
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Top thriller</span>
                <span className="font-semibold tabular-nums">
                  {records.thriller
                    ? `#${records.thriller.matchNo}: ${records.thriller.myGoals}–${records.thriller.opponentGoals} (${records.thriller.combined})`
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground uppercase">Best pass acc.</span>
                <span className="font-semibold tabular-nums">
                  {records.bestPassAccuracy
                    ? `#${records.bestPassAccuracy.matchNo}: ${fmt(records.bestPassAccuracy.pct)}% (${
                        records.bestPassAccuracy.side === "me" ? meName : oppName
                      })`
                    : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      {/* Middle: full-width average stats comparison table */}
      <Card className="col-span-1 lg:col-span-12">
        <CardHeader>
          <CardTitle>Average Match Stats</CardTitle>
          <CardDescription>
            Per-match averages over the games where each stat was recorded — missing stats never
            drag the numbers down.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="hidden grid-cols-[1.4fr_1fr_2.5fr_1fr_1.4fr] gap-3 border-b pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase md:grid">
            <span>Stat</span>
            <span className="text-right">{meName} Avg</span>
            <span className="text-center">Tug of war</span>
            <span className="text-left">{oppName} Avg</span>
            <span className="text-right">Sample</span>
          </div>
          {comparison.stats.map((s) => {
            const sum = (s.mine.avg ?? 0) + (s.theirs.avg ?? 0);
            const myPct = sum > 0 && s.mine.avg !== null ? (s.mine.avg / sum) * 100 : 0;
            const digits = s.key === "possession" ? 0 : 1;
            const unlogged = s.mine.avg === null && s.theirs.avg === null;
            const sample =
              s.mine.count === 0
                ? `— (${s.mine.count} matches)`
                : `${s.mine.count} match${s.mine.count === 1 ? "" : "es"}`;
            return (
              <div key={s.key} className="contents">
                {/* Mobile: crisp 2-line row (values line + tug-of-war bar) */}
                <div className="flex flex-col gap-1.5 rounded-lg bg-secondary/40 p-2.5 md:hidden">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="w-14 text-left font-heading text-lg font-bold tabular-nums text-primary">
                      {fmt(s.mine.avg, digits)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-muted-foreground">
                      {s.label}{" "}
                      <span className="whitespace-nowrap">({sample.replace(" matches", "m").replace(" match", "m")})</span>
                    </span>
                    <span className="w-14 text-right font-heading text-lg font-bold tabular-nums text-accent-pink">
                      {fmt(s.theirs.avg, digits)}
                    </span>
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-secondary">
                    {unlogged ? (
                      <span className="w-full text-center text-[10px] leading-2.5 text-muted-foreground">
                        not recorded yet
                      </span>
                    ) : (
                      <>
                        <div className="h-full bg-primary" style={{ width: `${myPct}%` }} />
                        <div className="h-full flex-1 bg-accent-pink" />
                      </>
                    )}
                  </div>
                </div>
                {/* Desktop row: unchanged */}
                <div className="hidden items-center gap-3 md:grid md:grid-cols-[1.4fr_1fr_2.5fr_1fr_1.4fr]">
                  <span className="text-sm font-medium md:text-base">{s.label}</span>
                  <span className="text-right font-semibold tabular-nums text-primary md:text-base">
                    {fmt(s.mine.avg, digits)}
                  </span>
                  <div className="flex h-3 items-center overflow-hidden rounded-full bg-secondary">
                    {unlogged ? (
                      <span className="w-full text-center text-[10px] text-muted-foreground">
                        not recorded yet
                      </span>
                    ) : (
                      <>
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${myPct}%` }}
                        />
                        <div
                          className="h-full flex-1 bg-accent-pink transition-all"
                          style={{ width: `${100 - myPct}%` }}
                        />
                      </>
                    )}
                  </div>
                  <span className="font-semibold tabular-nums text-accent-pink md:text-left md:text-base">
                    {fmt(s.theirs.avg, digits)}
                  </span>
                  <span className="text-right text-xs text-muted-foreground">{sample}</span>
                </div>
              </div>
            );
          })}
          {/* Efficiency & shooting ratios */}
          <div className="mt-2 grid grid-cols-1 gap-3 rounded-lg bg-secondary/50 p-3 md:grid-cols-3">
            {(
              [
                ["Shot Accuracy", comparison.shotAccuracy],
                ["Goal Conversion", comparison.goalConversion],
                ["Pass Accuracy", comparison.passAccuracy],
              ] as const
            ).map(([label, rate]) => {
              const sum = (rate.mine ?? 0) + (rate.theirs ?? 0);
              const myPct = sum > 0 && rate.mine !== null ? (rate.mine / sum) * 100 : 0;
              return (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {label} %
                  </span>
                  <div className="flex items-center justify-between text-sm font-semibold tabular-nums">
                    <span className="text-primary">{fmt(rate.mine)}</span>
                    <span className="text-accent-pink">{fmt(rate.theirs)}</span>
                  </div>
                  <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full bg-primary" style={{ width: `${myPct}%` }} />
                    <div className="h-full flex-1 bg-accent-pink" />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Bottom: synchronized match history + collapsible upload trigger */}
      {uploadSlot ? (
        <details className="group rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
          <summary className="cursor-pointer list-none font-heading text-lg font-semibold tracking-wide uppercase select-none">
            <span className="text-primary group-open:hidden">+ Add Match Screenshot</span>
            <span className="hidden text-muted-foreground group-open:inline">− Hide upload form</span>
          </summary>
          <div className="pt-3">{uploadSlot}</div>
        </details>
      ) : null}
      <MatchList matches={filteredDisplay} opponentUsername={opponentUsername} />
    </div>
  );
}
