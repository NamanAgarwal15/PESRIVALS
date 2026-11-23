"use client";

// The interactive rivalry dashboard: a full-width Bento layout with two tabs
// (Overview | Visual Analysis), a sticky global filter bar with user-relative
// labels, and the match history — all recomputed live from the pure
// analytics engine in rivalry-analytics.ts.

import { useMemo, useState } from "react";
import { type CoachQuotaInfo, RivalryCoachChat } from "@/components/dashboard/rivalry-coach-chat";
import type { ChartTeams } from "@/components/dashboard/rivalry-charts";
import { AnalysisTab } from "@/components/dashboard/analysis-tab";
import { OverviewTab } from "@/components/dashboard/overview-tab";
import type { RivalryMatch } from "@/lib/match-helpers";
import {
  type AnalyticsFilters,
  type AnalyticsHostFilter,
  type AnalyticsOutcomeFilter,
  type AnalyticsWindow,
  DEFAULT_FILTERS,
  MARGIN_OPTIONS,
  computeRivalryAnalytics,
} from "@/lib/rivalry-analytics";

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

type Tab = "overview" | "analysis";

export function RivalryDashboard({
  rivalryId,
  coachQuota,
  matches,
  displayMatches,
  meName,
  oppName,
  opponentUsername,
  uploadSlot,
}: {
  rivalryId: string;
  coachQuota?: CoachQuotaInfo | null;
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
      <RivalryCoachChat rivalryId={rivalryId} initialQuota={coachQuota ?? null} />
    </div>
  );
}
