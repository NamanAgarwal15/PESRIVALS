"use client";

// Recharts visualizations for the rivalry dashboard. Colors come from the
// theme CSS variables only (no hex literals).

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type StatComparison, type TrendPoint } from "@/lib/rivalry-analytics";

const COLOR = {
  me: "var(--primary)",
  opp: "var(--accent-pink)",
  diff: "var(--accent-blue)",
  grid: "var(--border)",
  text: "var(--muted-foreground)",
};

const axisProps = {
  stroke: COLOR.text,
  fontSize: 11,
  tickLine: false,
} as const;

const tooltipStyle = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  color: "var(--foreground)",
  fontSize: 12,
};

/** Chart 1: goals per match + goal difference, over the filtered window. */
export function GoalsTrendChart({ series }: { series: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="matchNo" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `Match #${v}`} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="myGoals" name="My goals" fill={COLOR.me} radius={[3, 3, 0, 0]} />
        <Bar dataKey="oppGoals" name="Opponent goals" fill={COLOR.opp} radius={[3, 3, 0, 0]} />
        <Line type="monotone" dataKey="goalDiff" name="Goal diff" stroke={COLOR.diff} dot={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Chart 2: cumulative head-to-head lead over the match numbers. */
export function MomentumChart({ series }: { series: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="matchNo" {...axisProps} />
        <YAxis {...axisProps} allowDecimals={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(v) => `Match #${v}`}
          formatter={(v) => [`${v} matches`, "Net lead"]}
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
  );
}

// --- CORE STAT COMPARISON BARS ---

const CORE_BARS: {
  key: string;
  label: string;
  mine: (c: StatComparison) => number | null;
  theirs: (c: StatComparison) => number | null;
}[] = [
  {
    key: "possession",
    label: "Possession %",
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
    key: "passacc",
    label: "Pass accuracy %",
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

/** Chart 3: core-stat comparison as horizontal share bars + radar. */
export function CoreStatBars({
  comparison,
  meName,
  oppName,
}: {
  comparison: StatComparison;
  meName: string;
  oppName: string;
}) {
  const data = CORE_BARS.map((row) => {
    const mine = row.mine(comparison);
    const theirs = row.theirs(comparison);
    const total = (mine ?? 0) + (theirs ?? 0);
    return {
      label: row.label,
      // Share of the combined value, so every stat is comparable on one axis.
      myShare: total > 0 && mine !== null ? (mine / total) * 100 : 0,
      logged: mine !== null && theirs !== null,
    };
  });

  const radarData = CORE_BARS.filter((_, i) => data[i].logged).map((row) => ({
    stat: row.label,
    [meName]: row.mine(comparison) ?? 0,
    [oppName]: row.theirs(comparison) ?? 0,
  }));

  return (
    <div className="flex flex-col gap-4">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 24, bottom: 0 }}
          stackOffset="expand"
        >
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" {...axisProps} width={96} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v) => [`${Number(v).toFixed(1)}% of combined`, "Share"]}
          />
          <Bar dataKey="myShare" name={meName}>
            {data.map((d) => (
              <Cell key={d.label} fill={d.logged ? COLOR.me : "var(--muted)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {radarData.length >= 3 ? (
        <ResponsiveContainer width="100%" height={220}>
          <RadarChart data={radarData} outerRadius="72%">
            <PolarGrid stroke={COLOR.grid} />
            <PolarAngleAxis dataKey="stat" tick={{ fill: COLOR.text, fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Radar
              name={meName}
              dataKey={meName}
              stroke={COLOR.me}
              fill={COLOR.me}
              fillOpacity={0.3}
            />
            <Radar
              name={oppName}
              dataKey={oppName}
              stroke={COLOR.opp}
              fill={COLOR.opp}
              fillOpacity={0.3}
            />
          </RadarChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
