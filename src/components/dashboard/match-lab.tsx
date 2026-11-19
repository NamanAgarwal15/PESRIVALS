"use client";

// "Match Lab & Forecast": Stage 3A forecast, Stage 3B deep ratings and Tier 2
// causal inference, each showing its unlock threshold until enough matches exist.

import { useMemo, useState } from "react";
import { MatchSimulator } from "@/components/dashboard/match-simulator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type HostSeat, forecastMatch, STAGE_3A_MIN, STAGE_3B_MIN, TIER2_MIN_TAGGED, computeMatchLab, type AteResult } from "@/lib/predictive-analytics";
import type { AnalyticsMatch } from "@/lib/rivalry-analytics";

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const signed = (v: number, d = 0) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const w = Math.min(100, (value / max) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 rounded-full bg-secondary" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <div className="h-2 rounded-full bg-primary" style={{ width: `${w}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Effect({ title, r }: { title: string; r: AteResult }) {
  if (!r) return <p className="text-sm text-muted-foreground">{title}: not enough variation to estimate yet.</p>;
  return (
    <p className="text-sm">
      <b>{title}:</b> <span className={r.ate >= 0 ? "text-win" : "text-loss"}>{signed(r.ate * 100)} pts</span> win probability
      <span className="text-muted-foreground"> (95% CI {signed(r.lo * 100)} to {signed(r.hi * 100)}, {r.nTreated} vs {r.nControl} matches)</span>
    </p>
  );
}

export function MatchLab({ matches, meName, oppName }: { matches: AnalyticsMatch[]; meName: string; oppName: string }) {
  const [host, setHost] = useState<HostSeat>(null);
  const lab = useMemo(() => computeMatchLab(matches, host), [matches, host]);
  const f = lab.forecast;
  // Neutral-venue baseline for the simulator (it applies host and style effects itself).
  const simBase = useMemo(() => {
    const b = forecastMatch(matches, null);
    return b.unlocked ? { lambdaMe: b.lambdaMe, lambdaOpp: b.lambdaOpp, lambda3: b.lambda3 } : null;
  }, [matches]);
  const deep = lab.deep.unlocked ? lab.deep : null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Match Lab &amp; Forecast</CardTitle>
        <CardDescription>Predictions and cause-and-effect estimates from every confirmed match. Each part unlocks as the rivalry grows.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold uppercase">Next-match forecast</h3>
          {!f.unlocked ? (
            <Progress value={f.n} max={STAGE_3A_MIN} label={`${f.n} / ${STAGE_3A_MIN} matches to unlock the forecast`} />
          ) : (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Who hosts the next match">
                {([["Neutral", null], [`${meName} hosts`, "me"], [`${oppName} hosts`, "opponent"]] as [string, HostSeat][]).map(([label, v]) => (
                  <button key={label} type="button" aria-pressed={host === v} onClick={() => setHost(v)} className="min-h-9 rounded-full border border-input px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground">
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex h-8 overflow-hidden rounded-md text-xs font-semibold" role="img" aria-label={`Win ${pct(f.win)}, draw ${pct(f.draw)}, loss ${pct(f.loss)}`}>
                <div className="flex items-center justify-center bg-win/70" style={{ width: `${f.win * 100}%` }}>{pct(f.win)}</div>
                <div className="flex items-center justify-center bg-draw/70" style={{ width: `${f.draw * 100}%` }}>{f.draw >= 0.08 ? pct(f.draw) : ""}</div>
                <div className="flex items-center justify-center bg-loss/70" style={{ width: `${f.loss * 100}%` }}>{pct(f.loss)}</div>
              </div>
              <p className="text-xs text-muted-foreground">{meName} win · draw · {oppName} win. Expected goals {f.lambdaMe.toFixed(2)} – {f.lambdaOpp.toFixed(2)}. Most likely exact score {f.likely.me}–{f.likely.opp} ({(f.likely.p * 100).toFixed(1)}%). “6+” pools every score of 6 or more goals for that side.</p>
              <p className="text-sm">In plain English: {meName} has about a {pct(f.win)} chance to win the next match, {pct(f.draw)} to draw and {pct(f.loss)} to lose to {oppName}. This is built from how many goals each of you has scored lately (recent matches count more). It is a guide, not a promise.</p>
              <div className="overflow-x-auto">
                <table className="text-center text-xs tabular-nums" aria-label="Exact score probabilities">
                  <thead>
                    <tr><th className="p-1 text-muted-foreground">{meName} \ {oppName}</th>{[0, 1, 2, 3, 4, 5, "6+"].map((y) => <th key={y} className="p-1">{y}</th>)}</tr>
                  </thead>
                  <tbody>
                    {f.grid.map((row, x) => (
                      <tr key={x}>
                        <th className="p-1">{x === 6 ? "6+" : x}</th>
                        {row.map((p, y) => {
                          // Only an exact (unpooled) cell is ever highlighted; the 6+ pool is not a scoreline.
                          const best = x < 6 && y < 6 && x === f.likely.me && y === f.likely.opp;
                          return (
                            <td key={y} className={`min-w-11 rounded p-1 ${best ? "ring-2 ring-primary font-bold" : ""}`} style={{ backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round(p * 400)}%, transparent)` }}>
                              {(p * 100).toFixed(1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold uppercase">Deep ratings, tilt &amp; playstyle clash</h3>
          {!deep ? (
            <Progress value={lab.n} max={STAGE_3B_MIN} label={`${lab.n} / ${STAGE_3B_MIN} matches to unlock`} />
          ) : (
            <>
              <p className="text-sm">
                <b>Glicko-2:</b> {meName} {deep.ratings.me.rating.toFixed(0)} ± {(deep.ratings.me.rd * 2).toFixed(0)} · {oppName} {deep.ratings.opp.rating.toFixed(0)} ± {(deep.ratings.opp.rd * 2).toFixed(0)}
                <span className="text-muted-foreground"> (volatility {deep.ratings.me.vol.toFixed(3)} / {deep.ratings.opp.vol.toFixed(3)})</span>
              </p>
              <p className="text-sm">In plain English: {(() => {
                const d = deep.ratings.me.rating - deep.ratings.opp.rating;
                const p = 1 / (1 + Math.pow(10, -d / 400));
                return Math.abs(d) < 10
                  ? `You and ${oppName} are rated almost the same (a 1500 rating is average).`
                  : `${d > 0 ? meName : oppName} is rated ${Math.abs(d).toFixed(0)} points higher, which means roughly a ${pct(d > 0 ? p : 1 - p)} chance to win any single game. The ± number is how unsure the rating still is: it shrinks as you play more.`;
              })()}</p>
              <p className="text-xs text-muted-foreground">Tilt = losing two or more in a row in one sitting, then playing worse for the rest of that sitting.</p>
              {(["me", "opp"] as const).map((k) => {
                const t = deep.tilt[k];
                return (
                  <p key={k} className="text-sm">
                    <b>{k === "me" ? meName : oppName} tilt:</b>{" "}
                    {t.tiltedSessions === 0
                      ? "no sessions with two losses in a row."
                      : `${t.tiltedSessions} session(s) with 2+ straight losses. Win rate after: ${t.afterWinPct === null ? "N/A" : `${t.afterWinPct.toFixed(0)}%`} vs ${t.baselineWinPct === null ? "N/A" : `${t.baselineWinPct.toFixed(0)}%`} otherwise${t.dropoff === null ? "" : ` (${signed(-t.dropoff)} pts)`}, over ${t.afterN} match(es).`}
                  </p>
                );
              })}
              {deep.clash.ready ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-80 text-sm">
                    <thead className="text-left text-xs text-muted-foreground uppercase"><tr><th className="py-1">{meName}</th><th>vs {oppName}</th><th>W-D-L</th><th>GD</th></tr></thead>
                    <tbody className="divide-y divide-border">
                      {deep.clash.rows.map((r) => (
                        <tr key={`${r.mine}|${r.theirs}`}><td className="py-1">{r.mine}</td><td>{r.theirs}</td><td className="tabular-nums">{r.wins}-{r.draws}-{r.losses}</td><td className="tabular-nums">{signed(r.goalDiff)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Tag both playstyles when you add matches to unlock the clash matrix ({deep.clash.tagged} / 3 tagged).</p>
              )}
            </>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold uppercase">Causal effects (Tier 2)</h3>
          {!lab.causal.ready ? (
            <Progress value={lab.causal.tagged} max={TIER2_MIN_TAGGED} label={`${lab.causal.tagged} / ${TIER2_MIN_TAGGED} tagged matches (host + your playstyle)`} />
          ) : (
            <>
              <Effect title="Effect of you hosting" r={lab.causal.host} />
              {lab.causal.playstyle ? <Effect title={`Effect of playing “${lab.causal.playstyle.style}”`} r={lab.causal.playstyle.result} /> : null}
              <p className="text-sm">In plain English: {(() => {
                const h = lab.causal.host;
                if (!h) return "There is not enough variety in who hosted yet to say whether hosting helps.";
                const pts = h.ate * 100;
                const clear = h.lo > 0 || h.hi < 0;
                return `When you host, your chance of winning looks about ${Math.abs(pts).toFixed(0)} points ${pts >= 0 ? "higher" : "lower"}, after accounting for your playstyle. ${clear ? "The range is clearly one-sided, so this is a real signal." : "But the range includes zero, so it could just be chance."}`;
              })()}</p>
              <p className="text-xs text-muted-foreground">Estimates with a 200-sample bootstrap range. They show what the data suggests, not guarantees.</p>
            </>
          )}
        </section>

        <MatchSimulator baseline={simBase} meName={meName} oppName={oppName} note={simBase ? undefined : "Using typical goal rates until you have 5 matches."} />
      </CardContent>
    </Card>
  );
}
