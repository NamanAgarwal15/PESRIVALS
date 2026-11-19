"use client";

// The interactive rivalry dashboard: a full-width Bento layout with two tabs
// (Overview | Visual Analysis), a sticky global filter bar with user-relative
// labels, and the match history — all recomputed live from the pure
// analytics engine in rivalry-analytics.ts.

import { useMemo, useState } from "react";
import { DerivedIndicesCard, EdaLab } from "@/components/dashboard/eda-lab";
import { MatchLab } from "@/components/dashboard/match-lab";
import { MatchList } from "@/components/matches/match-list";
import {
  ChartTeams,
  CoreStatBars,
  GoalsTrendChart,
  MomentumChart,
  PlaystyleRadar,
} from "@/components/dashboard/rivalry-charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RivalryMatch } from "@/lib/match-helpers";
import type { MatchOutcome } from "@/lib/match-stats";
import {
  type AnalyticsFilters,
  type AnalyticsHostFilter,
  type AnalyticsOutcomeFilter,
  type AnalyticsWindow,
  DEFAULT_FILTERS,
  MARGIN_OPTIONS,
  computeRivalryAnalytics,
} from "@/lib/rivalry-analytics";

function fmt(v: number | null, digits = 1): string {
  return v === null ? "—" : v.toFixed(digits);
}

const FORM_CLASS: Record<MatchOutcome, string> = {
  win: "bg-win/15 text-win",
  draw: "bg-draw/15 text-draw",
  loss: "bg-loss/15 text-loss",
};

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-semibold tracking-wide whitespace-nowrap transition-colors ${
        active ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
      }`}
    >
      {children}
    </button>
  );
}

const WINDOWS: { value: AnalyticsWindow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "last20", label: "Last 20" },
  { value: "last10", label: "Last 10" },
  { value: "last5", label: "Last 5" },
];
const MARGINS = MARGIN_OPTIONS.map((m) => ({ value: m, label: m === 0 ? "Any" : `${m}+ Goals` }));

const OUTCOMES: { value: AnalyticsOutcomeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "win", label: "My Wins" },
  { value: "draw", label: "Draws" },
  { value: "loss", label: "My Losses" },
];

function FilterRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {options.map((o) => (
        <Pill key={o.value} active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Pill>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="font-heading text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

type Tab = "overview" | "analysis";

export function RivalryDashboard({
  rivalryId,
  matches,
  displayMatches,
  meName,
  oppName,
  opponentUsername,
  uploadSlot,
}: {
  rivalryId: string;
  matches: Parameters<typeof computeRivalryAnalytics>[0];
  displayMatches: RivalryMatch[];
  meName: string;
  oppName: string;
  opponentUsername: string;
  /** Optional "Add Match Screenshot" panel; hidden in read-only previews. */
  uploadSlot?: React.ReactNode;
}) {
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_FILTERS);
  const [tab, setTab] = useState<Tab>("overview");
  const [showFilters, setShowFilters] = useState(false);

  const hosts: { value: AnalyticsHostFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "me", label: "Home (Me)" },
    { value: "opponent", label: `Away (@${opponentUsername})` },
  ];

  const set = (patch: Partial<AnalyticsFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    // Keep the URL shareable without triggering a server round-trip.
    const params = new URLSearchParams();
    if (next.window !== "all") params.set("window", next.window);
    if (next.host !== "all") params.set("host", next.host);
    if (next.outcome !== "all") params.set("outcome", next.outcome);
    if (next.minMargin > 0) params.set("margin", String(next.minMargin));
    const qs = params.toString();
    window.history.replaceState(null, "", `/rivalry/${rivalryId}${qs ? `?${qs}` : ""}`);
  };

  const model = useMemo(() => computeRivalryAnalytics(matches, filters), [matches, filters]);
  const { summary, hosting, comparison, series, records, derived, eda } = model;

  const filteredMatchNos = new Set(model.filtered.map((m) => m.matchNo));
  const filteredDisplay = displayMatches.filter(
    (m) => m.status === "disputed" || filteredMatchNos.has(m.matchNo),
  );
  const teams: ChartTeams = Object.fromEntries(
    displayMatches.map((m) => [
      m.matchNo,
      { myTeam: m.myTeam, opponentTeam: m.opponentTeam },
    ]),
  );

  const filtersActive =
    filters.window !== "all" ||
    filters.host !== "all" ||
    filters.outcome !== "all" ||
    filters.minMargin > 0;
  const activeSummary = [
    filters.window !== "all"
      ? WINDOWS.find((w) => w.value === filters.window)!.label
      : null,
    filters.host !== "all" ? hosts.find((h) => h.value === filters.host)!.label : null,
    filters.outcome !== "all"
      ? OUTCOMES.find((o) => o.value === filters.outcome)!.label
      : null,
    filters.minMargin > 0 ? `${filters.minMargin}+ goals` : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 overflow-x-hidden px-4 sm:px-6 lg:px-8">
      {/* Sticky header: tabs + global filters, shared by both tabs */}
      <div className="sticky top-0 z-20 -mx-4 flex flex-col gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="grid w-full grid-cols-2 gap-1 rounded-full bg-secondary p-1 md:inline-flex md:w-auto">
            {(
              [
                ["overview", "Overview"],
                ["analysis", "Visual Analysis"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded-full px-2 py-1.5 text-xs font-bold tracking-wide uppercase transition-colors md:px-4 ${
                  tab === value
                    ? "bg-primary text-primary-foreground"
                    : "text-secondary-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {filtersActive ? (
            <div className="hidden min-w-0 items-center gap-2 md:flex">
              <span className="hidden truncate rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground md:inline">
                Showing {summary.played} {summary.played === 1 ? "match" : "matches"} ·{" "}
                {activeSummary.join(" · ")}
              </span>
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Reset
              </button>
            </div>
          ) : null}
        </div>
        {/* Mobile: compact collapsible filter drawer (md:hidden) */}
        <div className="flex items-center gap-2 md:hidden">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-semibold tracking-wide text-secondary-foreground"
          >
            Filters
            {activeSummary.length > 0 ? (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {activeSummary.length}
              </span>
            ) : null}
            <span aria-hidden>{showFilters ? "▲" : "▼"}</span>
          </button>
          {activeSummary.length > 0 ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {summary.played} matches · {activeSummary.join(" · ")}
              </span>
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_FILTERS)}
                className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Reset
              </button>
            </>
          ) : null}
        </div>
        {showFilters ? (
          <div className="flex flex-col gap-2 md:hidden">
            <FilterRow
              label="Window"
              options={WINDOWS}
              value={filters.window}
              onChange={(v) => set({ window: v })}
            />
            <FilterRow
              label="Venue"
              options={hosts}
              value={filters.host}
              onChange={(v) => set({ host: v })}
            />
            <FilterRow
              label="Result"
              options={OUTCOMES}
              value={filters.outcome}
              onChange={(v) => set({ outcome: v })}
            />
            <FilterRow
              label="Margin"
              options={MARGINS}
              value={filters.minMargin}
              onChange={(v) => set({ minMargin: v })}
            />
          </div>
        ) : null}
        <div className="hidden flex-col gap-2 md:flex">
          <FilterRow
            label="Window"
            options={WINDOWS}
            value={filters.window}
            onChange={(v) => set({ window: v })}
          />
          <FilterRow
            label="Venue"
            options={hosts}
            value={filters.host}
            onChange={(v) => set({ host: v })}
          />
          <FilterRow
            label="Result"
            options={OUTCOMES}
            value={filters.outcome}
            onChange={(v) => set({ outcome: v })}
          />
          <FilterRow
            label="Margin"
            options={MARGINS}
            value={filters.minMargin}
            onChange={(v) => set({ minMargin: v })}
          />
        </div>
      </div>
      {tab === "overview" ? (
        <OverviewTab
          summary={summary}
          hosting={hosting}
          comparison={comparison}
          records={records}
          meName={meName}
          oppName={oppName}
          opponentUsername={opponentUsername}
          filteredDisplay={filteredDisplay}
          uploadSlot={uploadSlot}
        />
      ) : (
        <AnalysisTab
          series={series}
          comparison={comparison}
          meName={meName}
          oppName={oppName}
          teams={teams}
          played={summary.played}
          derived={derived}
          eda={eda}
          allMatches={matches}
        />
      )}
    </div>
  );
}

// --- OVERVIEW TAB ---

function OverviewTab({
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

function AnalysisTab({
  series,
  comparison,
  meName,
  oppName,
  teams,
  played,
  derived,
  eda,
  allMatches,
}: {
  series: ReturnType<typeof computeRivalryAnalytics>["series"];
  comparison: ReturnType<typeof computeRivalryAnalytics>["comparison"];
  meName: string;
  oppName: string;
  teams: ChartTeams;
  played: number;
  derived: ReturnType<typeof computeRivalryAnalytics>["derived"];
  eda: ReturnType<typeof computeRivalryAnalytics>["eda"];
  /** Unfiltered matches: the forecast does not depend on the dashboard filters. */
  allMatches: Parameters<typeof computeRivalryAnalytics>[0];
}) {
  if (played === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-1 py-12 text-center">
          <p className="font-heading text-2xl font-semibold tracking-wide uppercase">
            Nothing to analyse yet
          </p>
          <p className="text-sm text-muted-foreground">
            The current filters match no matches — loosen them above.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Goals Scored per Match</CardTitle>
          <CardDescription>
            How many goals each of you scored in every match of the selected window — hover a bar
            for the exact scoreline and result.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GoalsTrendChart series={series} meName={meName} oppName={oppName} teams={teams} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Rivalry Lead Tracker</CardTitle>
          <CardDescription>
            How many wins ahead (+) or behind (−) you are over time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MomentumChart series={series} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Core Per-Match Comparison</CardTitle>
          <CardDescription>
            Your average against {oppName}&apos;s for the core metrics — longer bar, better number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CoreStatBars comparison={comparison} meName={meName} oppName={oppName} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Playstyle Balance</CardTitle>
          <CardDescription>
            Each axis is scaled to the better of the two of you (100%), so the polygons show who
            dominates which part of the game.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlaystyleRadar comparison={comparison} meName={meName} oppName={oppName} />
        </CardContent>
      </Card>
      <MatchLab matches={allMatches} meName={meName} oppName={oppName} />
      <DerivedIndicesCard derived={derived} meName={meName} oppName={oppName} />
      <EdaLab eda={eda} meName={meName} oppName={oppName} />
    </div>
  );
}

