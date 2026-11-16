"use client";

// Recharts visualizations for the rivalry dashboard. Colors come from the
// theme CSS variables only (no hex literals). Every chart gets a custom
// tooltip with exact match numbers and scorelines.

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type StatComparison, type TrendPoint } from "@/lib/rivalry-analytics";
import { matchOutcome } from "@/lib/match-stats";

const COLOR = {
  me: "var(--primary)",
  opp: "var(--accent-pink)",
  diff: "var(--accent-blue)",
  win: "var(--win)",
  draw: "var(--draw)",
  loss: "var(--loss)",
  grid: "var(--border)",
  text: "var(--muted-foreground)",
};

const axisProps = {
  stroke: COLOR.text,
  fontSize: 11,
  tickLine: false,
} as const;

const RESULT_COLOR: Record<string, string> = {
  W: COLOR.win,
  D: COLOR.draw,
  L: COLOR.loss,
};

function TipShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid var(--border)",
        color: "var(--foreground)",
      }}
    >
      {children}
    </div>
  );
}

export type ChartTeams = Record<number, { myTeam: string; opponentTeam: string }>;

/** Chart 1: grouped goals bars (no spline). Tooltip: #, teams, score, result, GD. */
export function GoalsTrendChart({
  series,
  meName,
  oppName,
  teams,
}: {
  series: TrendPoint[];
  meName: string;
  oppName: string;
  teams?: ChartTeams;
}) {
  return (
    <div className="h-56 w-full overflow-hidden md:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barGap={2}>
        <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="matchNo" interval="preserveStartEnd" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const point = series.find((p) => p.matchNo === label);
            if (!point) return null;
            const outcome = matchOutcome(point.myGoals, point.oppGoals, false);
            const badge = outcome === "win" ? "W" : outcome === "draw" ? "D" : "L";
            const t = teams?.[point.matchNo];
            return (
              <TipShell>
                <p className="mb-1 font-semibold">Match #{point.matchNo}</p>
                {t ? (
                  <p className="text-muted-foreground">
                    {t.myTeam} vs {t.opponentTeam}
                  </p>
                ) : null}
                <p className="tabular-nums">
                  <span style={{ color: COLOR.me }}>
                    {meName}: {point.myGoals}
                  </span>{" "}
                  ·{" "}
                  <span style={{ color: COLOR.opp }}>
                    {oppName}: {point.oppGoals}
                  </span>
                </p>
                <p>
                  Result{" "}
                  <span className="font-bold" style={{ color: RESULT_COLOR[badge] }}>
                    {badge}
                  </span>{" "}
                  <span className="tabular-nums text-muted-foreground">
                    (GD {point.goalDiff > 0 ? "+" : ""}
                    {point.goalDiff})
                  </span>
                </p>
              </TipShell>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="myGoals" name={`${meName} goals`} fill={COLOR.me} radius={[3, 3, 0, 0]} />
        <Bar dataKey="oppGoals" name={`${oppName} goals`} fill={COLOR.opp} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Chart 2: net rivalry lead over time with a dashed zero baseline. */
export function MomentumChart({ series }: { series: TrendPoint[] }) {
  return (
    <div className="h-56 w-full overflow-hidden md:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="matchNo" interval="preserveStartEnd" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <ReferenceLine y={0} stroke={COLOR.text} strokeDasharray="4 4" />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const v = Number(payload[0].value);
            return (
              <TipShell>
                <p className="mb-1 font-semibold">Match #{label}</p>
                <p className="tabular-nums">
                  {v > 0 ? `Ahead by ${v}` : v < 0 ? `Behind by ${-v}` : "Level"}{" "}
                  <span className="text-muted-foreground">
                    ({v > 0 ? "+" : ""}
                    {v} net wins)
                  </span>
                </p>
              </TipShell>
            );
          }}
        />
        <Area
          type="stepAfter"
          dataKey="h2hNetWins"
          name="Net lead"
          stroke={COLOR.diff}
          fill={COLOR.diff}
          fillOpacity={0.25}
        />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
// --- CHARTS 3 & 4 ---


// The core per-match metrics compared in charts 3 and 4.
const CORE_STATS: {
  key: string;
  label: string;
  suffix?: string;
  mine: (c: StatComparison) => number | null;
  theirs: (c: StatComparison) => number | null;
}[] = [
  {
    key: "possession",
    label: "Possession",
    suffix: "%",
    mine: (c) => c.stats.find((s) => s.key === "possession")?.mine.avg ?? null,
    theirs: (c) => c.stats.find((s) => s.key === "possession")?.theirs.avg ?? null,
  },
  {
    key: "shots",
    label: "Shots",
    mine: (c) => c.stats.find((s) => s.key === "shots")?.mine.avg ?? null,
    theirs: (c) => c.stats.find((s) => s.key === "shots")?.theirs.avg ?? null,
  },
  {
    key: "sot",
    label: "Shots on target",
    mine: (c) => c.stats.find((s) => s.key === "shots_on_target")?.mine.avg ?? null,
    theirs: (c) => c.stats.find((s) => s.key === "shots_on_target")?.theirs.avg ?? null,
  },
  {
    key: "shotacc",
    label: "Shot accuracy",
    suffix: "%",
    mine: (c) => c.shotAccuracy.mine,
    theirs: (c) => c.shotAccuracy.theirs,
  },
  {
    key: "passacc",
    label: "Pass accuracy",
    suffix: "%",
    mine: (c) => c.passAccuracy.mine,
    theirs: (c) => c.passAccuracy.theirs,
  },
  {
    key: "tackles",
    label: "Tackles",
    mine: (c) => c.stats.find((s) => s.key === "tackles")?.mine.avg ?? null,
    theirs: (c) => c.stats.find((s) => s.key === "tackles")?.theirs.avg ?? null,
  },
];

function coreValues(comparison: StatComparison) {
  return CORE_STATS.map((row) => {
    const mine = row.mine(comparison);
    const theirs = row.theirs(comparison);
    const suffix = row.suffix ?? "";
    return {
      label: row.label,
      mine: mine ?? 0,
      theirs: theirs ?? 0,
      mineLabel: mine === null ? "—" : `${mine.toFixed(1)}${suffix}`,
      theirsLabel: theirs === null ? "—" : `${theirs.toFixed(1)}${suffix}`,
      logged: mine !== null && theirs !== null,
    };
  });
}

/** CHART 3 IMPL */


/**
 * Chart 3: side-by-side horizontal grouped bars with explicit numeric value
 * labels. Both players' bars are scaled against the row maximum, so neither
 * collapses to zero width (fixes the old 100%-yellow stacked bug).
 */
export function CoreStatBars({
  comparison,
  meName,
  oppName,
}: {
  comparison: StatComparison;
  meName: string;
  oppName: string;
}) {
  const rows = coreValues(comparison).filter((r) => r.logged);
  const rowMax = Math.max(...rows.map((r) => Math.max(r.mine, r.theirs)), 1);

  return (
    <ResponsiveContainer width="100%" height={Math.max(rows.length * 56 + 24, 160)}>
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 56, left: 8, bottom: 0 }}
        barGap={4}
      >
        <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" domain={[0, rowMax]} hide />
        <YAxis type="category" dataKey="label" {...axisProps} width={104} />
        <Tooltip
          cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = rows.find((r) => r.label === payload[0].payload?.label) ?? rows[0];
            if (!row) return null;
            return (
              <TipShell>
                <p className="mb-1 font-semibold">{row.label} (per match avg)</p>
                <p style={{ color: COLOR.me }}>
                  {meName}: {row.mineLabel}
                </p>
                <p style={{ color: COLOR.opp }}>
                  {oppName}: {row.theirsLabel}
                </p>
              </TipShell>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="mine" name={meName} fill={COLOR.me} radius={[0, 3, 3, 0]}>
          <LabelList
            dataKey="mineLabel"
            position="right"
            style={{ fill: COLOR.me, fontSize: 11, fontWeight: 600 }}
          />
        </Bar>
        <Bar dataKey="theirs" name={oppName} fill={COLOR.opp} radius={[0, 3, 3, 0]}>
          <LabelList
            dataKey="theirsLabel"
            position="right"
            style={{ fill: COLOR.opp, fontSize: 11, fontWeight: 600 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Chart 4: playstyle radar, every axis normalized independently to 0-100. */
export function PlaystyleRadar({
  comparison,
  meName,
  oppName,
}: {
  comparison: StatComparison;
  meName: string;
  oppName: string;
}) {
  const radarData = coreValues(comparison)
    .filter((r) => r.logged)
    .map((r) => {
      const max = Math.max(r.mine, r.theirs, 1);
      return {
        stat: r.label,
        me: (r.mine / max) * 100,
        opp: (r.theirs / max) * 100,
      };
    });

  if (radarData.length < 3) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Not enough recorded stats yet for the radar.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={radarData} outerRadius="70%">
        <PolarGrid stroke={COLOR.grid} />
        <PolarAngleAxis dataKey="stat" tick={{ fill: COLOR.text, fontSize: 10 }} />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            return (
              <TipShell>
                <p className="mb-1 font-semibold">{label}</p>
                {payload.map((p) => (
                  <p key={String(p.name)} style={{ color: p.color as string }}>
                    {p.name}: {Number(p.value).toFixed(0)}% of axis max
                  </p>
                ))}
              </TipShell>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Radar name={meName} dataKey="me" stroke={COLOR.me} fill={COLOR.me} fillOpacity={0.3} />
        <Radar name={oppName} dataKey="opp" stroke={COLOR.opp} fill={COLOR.opp} fillOpacity={0.3} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

