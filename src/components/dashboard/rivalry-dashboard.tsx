"use client";

// The interactive rivalry dashboard: filters (synced to the URL), H2H hero,
// form strip, Recharts charts, hosting table, 13-stat comparison, records
// and the match history — all recomputed live from the pure analytics engine.

import { useMemo, useState } from "react";
import { MatchList } from "@/components/matches/match-list";
import { CoreStatBars, GoalsTrendChart, MomentumChart } from "@/components/dashboard/rivalry-charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
const HOSTS: { value: AnalyticsHostFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "me", label: "Home" },
  { value: "opponent", label: "Away" },
];
const OUTCOMES: { value: AnalyticsOutcomeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "win", label: "Wins" },
  { value: "draw", label: "Draws" },
  { value: "loss", label: "Losses" },
];

function FilterRow<T extends string>({
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

export function RivalryDashboard({
  rivalryId,
  matches,
  displayMatches,
  meName,
  oppName,
  opponentUsername,
}: {
  rivalryId: string;
  matches: Parameters<typeof computeRivalryAnalytics>[0];
  displayMatches: RivalryMatch[];
  meName: string;
  oppName: string;
  opponentUsername: string;
}) {
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_FILTERS);

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
  const { summary, hosting, comparison, series, records } = model;

  const filteredMatchNos = new Set(model.filtered.map((m) => m.matchNo));
  const filteredDisplay = displayMatches.filter((m) => filteredMatchNos.has(m.matchNo));

  const total = summary.wins + summary.draws + summary.losses || 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Filter bar */}
      <Card size="sm">
        <CardContent className="flex flex-col gap-2">
          <FilterRow
            label="Window"
            options={WINDOWS}
            value={filters.window}
            onChange={(v) => set({ window: v })}
          />
          <FilterRow
            label="Venue"
            options={HOSTS}
            value={filters.host}
            onChange={(v) => set({ host: v })}
          />
          <FilterRow
            label="Result"
            options={OUTCOMES}
            value={filters.outcome}
            onChange={(v) => set({ outcome: v })}
          />
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Margin
            </span>
            {MARGIN_OPTIONS.map((m) => (
              <Pill key={m} active={filters.minMargin === m} onClick={() => set({ minMargin: m })}>
                {m === 0 ? "Any" : `${m}+`}
              </Pill>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="self-start text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Reset Filters
          </button>
        </CardContent>
      </Card>
      {/* H2H hero */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
            <Stat label="Matches" value={String(summary.played)} />
            <Stat label={`W (${meName})`} value={String(summary.wins)} />
            <Stat label="D" value={String(summary.draws)} />
            <Stat label={`L (${oppName})`} value={String(summary.losses)} />
            <Stat label="Win %" value={fmt(summary.winPct)} />
            <Stat label="Goals" value={`${summary.goalsFor}–${summary.goalsAgainst}`} />
            <Stat label="GD" value={`${summary.goalDiff > 0 ? "+" : ""}${summary.goalDiff}`} />
          </div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary">
            <div className="bg-win" style={{ width: `${(summary.wins / total) * 100}%` }} />
            <div className="bg-draw" style={{ width: `${(summary.draws / total) * 100}%` }} />
            <div className="bg-loss" style={{ width: `${(summary.losses / total) * 100}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>
                <span className="text-muted-foreground">Streak </span>
                <span className="font-semibold">{summary.currentStreak ?? "—"}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Best run </span>
                <span className="font-semibold text-win">W{summary.longestWinStreak}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Clean sheets </span>
                <span className="font-semibold">{summary.cleanSheets}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Biggest win </span>
                <span className="font-semibold">
                  {summary.biggestWin
                    ? `${summary.biggestWin.myGoals}–${summary.biggestWin.opponentGoals}`
                    : "—"}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Most goals </span>
                <span className="font-semibold">{summary.mostGoalsInGame?.goals ?? "—"}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Avg goals/game </span>
                <span className="font-semibold">{fmt(summary.avgGoalsFor, 2)}</span>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
      {/* Charts */}
      {series.length ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Goals &amp; Goal Difference</CardTitle>
            </CardHeader>
            <CardContent>
              <GoalsTrendChart series={series} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>H2H Momentum (Cumulative Lead)</CardTitle>
            </CardHeader>
            <CardContent>
              <MomentumChart series={series} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Core Stats — {meName} vs {oppName}</CardTitle>
            </CardHeader>
            <CardContent>
              <CoreStatBars comparison={comparison} meName={meName} oppName={oppName} />
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* When Hosting */}
      <Card>
        <CardHeader>
          <CardTitle>When Hosting</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="grid grid-cols-6 gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <span className="col-span-2">Seat</span>
            <span>P</span>
            <span>W</span>
            <span>D</span>
            <span>L</span>
          </div>
          {hosting.rows.map((row) => (
            <div key={row.label} className="grid grid-cols-6 items-center gap-2 text-sm tabular-nums">
              <span className="col-span-2 truncate font-medium">{row.label}</span>
              <span>{row.played}</span>
              <span className="text-win">{row.myWins}</span>
              <span className="text-draw">{row.draws}</span>
              <span className="text-loss">{row.opponentWins}</span>
            </div>
          ))}
          <div className="grid grid-cols-6 gap-2 text-xs text-muted-foreground">
            <span className="col-span-6">
              Win % — {meName} hosting: {fmt(hosting.rows[0].winPct)} · {oppName} hosting:{" "}
              {fmt(hosting.rows[1].winPct)}
              {hosting.unattributed > 0
                ? ` · ${hosting.unattributed} match(es) with no host recorded`
                : ""}
            </span>
          </div>
        </CardContent>
      </Card>
      {/* All-stats breakdown with advantage bars */}
      <Card>
        <CardHeader>
          <CardTitle>Average Match Stats</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <span className="text-left">{meName}</span>
            <span>Stat</span>
            <span>Advantage</span>
            <span />
            <span className="text-right">{oppName}</span>
          </div>
          {comparison.stats.map((s) => {
            const max = Math.max(s.mine.avg ?? 0, s.theirs.avg ?? 0) || 1;
            const myPct = s.mine.avg === null ? 0 : (s.mine.avg / max) * 100;
            const theirPct = s.theirs.avg === null ? 0 : (s.theirs.avg / max) * 100;
            const digits = s.key === "possession" ? 0 : 1;
            return (
              <div
                key={s.key}
                className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-2 text-sm tabular-nums"
              >
                <span className="text-left font-medium">{fmt(s.mine.avg, digits)}</span>
                <span className="text-xs text-muted-foreground">{s.label}</span>
                <span className="flex w-24 items-center gap-0.5">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-l-full bg-secondary">
                    <span
                      className={`block h-full ${s.mine.avg !== null ? "bg-primary" : ""}`}
                      style={{ width: `${myPct}%`, marginLeft: "auto" }}
                    />
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-r-full bg-secondary">
                    <span
                      className={`block h-full ${s.theirs.avg !== null ? "bg-accent-pink" : ""}`}
                      style={{ width: `${theirPct}%` }}
                    />
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{s.mine.count}m</span>
                <span className="text-right font-medium">{fmt(s.theirs.avg, digits)}</span>
              </div>
            );
          })}
          <div className="mt-2 grid grid-cols-3 gap-2 border-t pt-2 text-sm tabular-nums">
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase">Shot accuracy %</span>
              <span>
                {fmt(comparison.shotAccuracy.mine)} vs {fmt(comparison.shotAccuracy.theirs)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase">Goal conversion %</span>
              <span>
                {fmt(comparison.goalConversion.mine)} vs{" "}
                {fmt(comparison.goalConversion.theirs)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase">Pass accuracy %</span>
              <span>
                {fmt(comparison.passAccuracy.mine)} vs {fmt(comparison.passAccuracy.theirs)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Records */}
      <Card>
        <CardHeader>
          <CardTitle>Trends &amp; Records</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground uppercase">Top thriller</span>
            <span className="font-semibold tabular-nums">
              {records.thriller
                ? `#${records.thriller.matchNo}: ${records.thriller.myGoals}–${records.thriller.opponentGoals} (${records.thriller.combined} goals)`
                : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground uppercase">Biggest blowout</span>
            <span className="font-semibold tabular-nums">
              {records.blowout
                ? `#${records.blowout.matchNo}: ${records.blowout.myGoals}–${records.blowout.opponentGoals}`
                : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground uppercase">Most shots</span>
            <span className="font-semibold tabular-nums">
              {records.mostShots
                ? `#${records.mostShots.matchNo}: ${records.mostShots.shots} (${
                    records.mostShots.side === "me" ? meName : oppName
                  })`
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

      {/* Match history, synchronized with the filters */}
      <MatchList matches={filteredDisplay} opponentUsername={opponentUsername} />
    </div>
  );
}

