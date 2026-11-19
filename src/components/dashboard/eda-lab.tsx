"use client";

// Tier 1B Bento cards: derived indices + the Rivalry EDA Lab. Display only;
// every number comes from the pure functions in rivalry-analytics.ts.

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { computeRivalryAnalytics } from "@/lib/rivalry-analytics";

type Model = ReturnType<typeof computeRivalryAnalytics>;

const NA = "N/A";
const num = (v: number | null, d = 1, suffix = "") => (v === null ? NA : `${v.toFixed(d)}${suffix}`);

function Row({ label, a, b, hint }: { label: string; a: string; b: string; hint?: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2 py-1.5 text-sm">
      <span className="text-left font-semibold tabular-nums">{a}</span>
      <span className="text-center text-muted-foreground">
        {label}
        {hint ? <span className="block text-xs">{hint}</span> : null}
      </span>
      <span className="text-right font-semibold tabular-nums">{b}</span>
    </div>
  );
}

export function DerivedIndicesCard({ derived, meName, oppName }: { derived: Model["derived"]; meName: string; oppName: string }) {
  const { mine, theirs } = derived;
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Derived Football Indices</CardTitle>
        <CardDescription>
          Smarter reads built from the raw stats. N/A means the stat was not recorded for those matches.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-1 grid grid-cols-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span className="truncate">{meName}</span>
          <span className="truncate text-right">{oppName}</span>
        </div>
        <div className="divide-y divide-border">
          <Row label="Shot Clinical Index" hint="goals per shot on target, shrunk to rivalry mean" a={num(mine.shotClinical, 1, "%")} b={num(theirs.shotClinical, 1, "%")} />
          <Row label="Build-Up Tempo" hint="passes per possession-minute" a={num(mine.buildUpTempo, 2)} b={num(theirs.buildUpTempo, 2)} />
          <Row label="Progressive Directness" hint="crosses as % of passes" a={num(mine.directness, 1, "%")} b={num(theirs.directness, 1, "%")} />
          <Row label="Pressing Intensity" hint="opp. passes per defensive action, lower = harder press" a={num(mine.pressing, 1)} b={num(theirs.pressing, 1)} />
          <Row label="Save Efficiency" hint="saves ÷ shots on target faced" a={num(mine.saveEfficiency, 1, "%")} b={num(theirs.saveEfficiency, 1, "%")} />
        </div>
      </CardContent>
    </Card>
  );
}

const pct = (v: number | null) => (v === null ? NA : `${v.toFixed(0)}%`);

export function EdaLab({ eda, meName, oppName }: { eda: Model["eda"]; meName: string; oppName: string }) {
  const { clutch, leading, correlations, sessions, scorelines } = eda;
  const maxCommon = Math.max(1, ...scorelines.common.map((s) => s.count));
  const maxMargin = Math.max(1, ...scorelines.margins.map((m) => m.count));
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Clutch &amp; Blowouts</CardTitle>
          <CardDescription>One-goal games, 4+ goal routs and average winning margin.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <Row label="One-goal record (W-D-L)" a={`${clutch.oneGoal.wins}-${clutch.oneGoal.draws}-${clutch.oneGoal.losses}`} b={`${clutch.oneGoal.losses}-${clutch.oneGoal.draws}-${clutch.oneGoal.wins}`} />
          <Row label="One-goal win %" hint={`${clutch.oneGoal.played} one-goal games`} a={pct(clutch.oneGoal.winPct)} b={pct(clutch.oneGoal.winPct === null ? null : 100 * clutch.oneGoal.losses / clutch.oneGoal.played)} />
          <Row label="Blowout wins (4+)" a={String(clutch.blowoutWins)} b={String(clutch.blowoutLosses)} />
          <Row label="Avg winning margin" a={num(clutch.avgWinMargin.mine, 2)} b={num(clutch.avgWinMargin.theirs, 2)} />
          <p className="text-xs text-muted-foreground">{meName} on the left, {oppName} on the right.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When Leading in a Stat → Win %</CardTitle>
          <CardDescription>How often each of you wins when you lead that stat. n = matches where you led.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {leading.map((r) => (
            <Row
              key={r.stat}
              label={r.label}
              a={r.mine.n ? `${pct(r.mine.winPct)} (n=${r.mine.n})` : NA}
              b={r.theirs.n ? `${pct(r.theirs.winPct)} (n=${r.theirs.n})` : NA}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stat vs Goal Difference (r)</CardTitle>
          <CardDescription>Rivalry-wide: across all your matches, how closely the gap between you and your rival in each stat tracks the final goal difference. It describes the rivalry as a whole, not one player. Right of centre favours you.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {correlations.map((c) => (
            <div key={c.stat} className="grid grid-cols-[6.5rem_1fr_5.5rem] items-center gap-2 text-sm">
              <span className="truncate text-muted-foreground">{c.label}</span>
              <div className="relative h-2 rounded-full bg-secondary" role="img" aria-label={`${c.label} correlation ${c.r === null ? "not available" : c.r.toFixed(2)}`}>
                <span className="absolute top-0 left-1/2 h-2 w-px bg-border" />
                {c.r !== null ? (
                  <span
                    className={`absolute top-0 h-2 rounded-full ${c.r >= 0 ? "bg-win" : "bg-loss"}`}
                    style={c.r >= 0 ? { left: "50%", width: `${c.r * 50}%` } : { right: "50%", width: `${-c.r * 50}%` }}
                  />
                ) : null}
              </div>
              <span className="text-right text-xs tabular-nums">
                {c.r === null ? NA : `r=${c.r.toFixed(2)}`} <span className="text-muted-foreground">{c.strength === "N/A" ? "" : c.strength}</span>
              </span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Needs at least 3 matches with the stat recorded.</p>
        </CardContent>
      </Card>

      <PersonalWinDrivers drivers={eda.drivers} meName={meName} oppName={oppName} />

      <Card>
        <CardHeader>
          <CardTitle>Session Log</CardTitle>
          <CardDescription>Every gaming day: record, goals and goals per match.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {sessions.length ? (
            <table className="w-full min-w-80 text-sm">
              <thead className="text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="py-1 text-left">Date</th><th>P</th><th>W-D-L</th><th>GF-GA</th><th className="text-right">G/M</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-center tabular-nums">
                {sessions.map((s) => (
                  <tr key={s.date}>
                    <td className="py-1 text-left">{s.date}</td>
                    <td>{s.played}</td>
                    <td>{s.wins}-{s.draws}-{s.losses}</td>
                    <td>{s.goalsFor}-{s.goalsAgainst}</td>
                    <td className="text-right">{num(s.goalsPerMatch, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No dated matches yet.</p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Scorelines &amp; Win Margins</CardTitle>
          <CardDescription>Your goals first. Penalty-decided matches count as draws, so they are not in the margin buckets.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase">Most common scorelines</h3>
            {scorelines.common.map((s) => (
              <div key={s.score} className="grid grid-cols-[3.5rem_1fr_2rem] items-center gap-2 text-sm">
                <span className="tabular-nums">{s.score}</span>
                <span className="h-2 rounded-full bg-primary" style={{ width: `${(s.count / maxCommon) * 100}%` }} />
                <span className="text-right tabular-nums">{s.count}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase">Win margin</h3>
            {scorelines.margins.map((m) => (
              <div key={m.label} className="grid grid-cols-[4.5rem_1fr_7rem] items-center gap-2 text-sm">
                <span>{m.label}</span>
                <span className="h-2 rounded-full bg-accent-pink" style={{ width: `${(m.count / maxMargin) * 100}%` }} />
                <span className="text-right text-xs tabular-nums">{m.count} ({m.mine} you / {m.theirs} rival)</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function PersonalWinDrivers({ drivers, meName, oppName }: { drivers: Model["eda"]["drivers"]; meName: string; oppName: string }) {
  const [who, setWho] = useState<"playerA" | "playerB">("playerA");
  const rows = drivers[who];
  const name = who === "playerA" ? meName : oppName;
  const avg = (v: number | null, stat: string) => (v === null ? NA : stat === "possession" || stat === "pass_accuracy" ? `${v.toFixed(1)}%` : v.toFixed(1));
  const best = rows
    .filter((r) => r.r !== null && r.lift !== null && r.winN >= 2 && r.lossN >= 2)
    .sort((a, b) => Math.abs(b.r!) - Math.abs(a.r!))[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal Win Drivers</CardTitle>
        <CardDescription>
          One player at a time: that player&apos;s own average in matches they won compared with matches they lost. Draws are left out. Each player gets their own numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2" role="group" aria-label="Choose a player">
          {([["playerA", meName], ["playerB", oppName]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={who === k} onClick={() => setWho(k)} className="min-h-9 max-w-40 truncate rounded-full border border-input px-3 text-sm font-medium aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground">
              {label}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-96 text-sm">
            <thead className="text-xs text-muted-foreground uppercase">
              <tr><th className="py-1 text-left">Stat</th><th>In wins</th><th>In losses</th><th>Lift</th><th className="text-right">r</th></tr>
            </thead>
            <tbody className="divide-y divide-border text-center tabular-nums">
              {rows.map((r) => (
                <tr key={r.stat}>
                  <td className="py-1 text-left">{r.label}</td>
                  <td>{avg(r.winAvg, r.stat)}{r.winN ? <span className="text-xs text-muted-foreground"> (n={r.winN})</span> : null}</td>
                  <td>{avg(r.lossAvg, r.stat)}{r.lossN ? <span className="text-xs text-muted-foreground"> (n={r.lossN})</span> : null}</td>
                  <td className={r.lift === null ? "" : r.lift >= 0 ? "text-win" : "text-loss"}>{r.lift === null ? NA : `${r.lift >= 0 ? "+" : "−"}${Math.abs(r.lift).toFixed(1)}`}</td>
                  <td className="text-right">{r.r === null ? NA : r.r.toFixed(2)} <span className="text-xs text-muted-foreground">{r.strength === "N/A" ? "" : r.strength}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          {best
            ? `In plain English: ${name} tends to win when ${best.label.toLowerCase()} is ${best.lift! >= 0 ? "higher" : "lower"} than usual (${avg(best.winAvg, best.stat)} in wins vs ${avg(best.lossAvg, best.stat)} in losses). This shows a pattern, not proof that it causes the win.`
            : "Not enough wins and losses with these stats recorded yet (needs at least 2 of each)."}
        </p>
      </CardContent>
    </Card>
  );
}
