// Personal Career Lab cards for /stats (server-rendered, presentational).
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CareerLab, InsightsResult } from "@/lib/career-lab";

const NA = "N/A";
const n = (v: number | null, d = 1, suffix = "") => (v === null ? NA : `${v.toFixed(d)}${suffix}`);
const signed = (v: number | null, d = 0, suffix = "") => (v === null ? NA : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}${suffix}`);

const CATEGORY: Record<string, string> = {
  form: "bg-win/15 text-win",
  tactics: "bg-primary/15 text-primary",
  rival: "bg-accent-pink/15 text-accent-pink",
  mindset: "bg-draw/15 text-draw",
  finishing: "bg-secondary text-secondary-foreground",
};

export function CareerLabSections({ lab, insights }: { lab: CareerLab; insights: InsightsResult | null }) {
  const pctStat = (stat: string) => stat === "possession" || stat === "pass_accuracy";
  return (
    <>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Matchday Coach Briefing</CardTitle>
          <CardDescription>
            Three fresh reads on your game. They only change when you log new matches, so refreshing never repeats or re-spends a request.
            {insights ? ` Source: ${insights.source === "ai" ? "AI coach" : "rule-based coach"}.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {insights ? (
            insights.insights.map((i) => (
              <div key={i.id} className="flex flex-col gap-2 rounded-lg bg-secondary/50 p-3">
                <span className={`self-start rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${CATEGORY[i.category] ?? CATEGORY.form}`}>{i.category}</span>
                <p className="font-semibold">{i.title}</p>
                <p className="text-sm text-muted-foreground">{i.body}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground md:col-span-3">The coach briefing is unavailable right now. Your stats below are unaffected.</p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Opponent-by-Opponent Matrix</CardTitle>
          <CardDescription>
            How you play each rival. The two shift columns compare that rival with your own career average, so you can spot where you change your game.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {lab.opponents.length ? (
            <table className="w-full min-w-176 text-sm">
              <thead className="text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="py-1 text-left">Rival</th><th>P</th><th>W-D-L</th><th>Win %</th><th>GF/G</th><th>GA/G</th>
                  <th>Poss</th><th>SoT</th><th>Clinical</th><th>Win % shift</th><th>Poss shift</th><th className="text-right">Top style</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-center tabular-nums">
                {lab.opponents.map((o) => (
                  <tr key={o.rivalryId}>
                    <td className="py-1.5 text-left">
                      <Link href={`/rivalry/${o.rivalryId}`} className="font-medium underline-offset-4 hover:underline">@{o.username}</Link>
                    </td>
                    <td>{o.played}</td>
                    <td>{o.played ? `${o.wins}-${o.draws}-${o.losses}` : NA}</td>
                    <td>{n(o.winPct, 0, "%")}</td>
                    <td>{n(o.goalsForPerGame, 2)}</td>
                    <td>{n(o.goalsAgainstPerGame, 2)}</td>
                    <td>{n(o.avgPossession, 0, "%")}</td>
                    <td>{n(o.avgShotsOnTarget, 1)}</td>
                    <td>{n(o.clinical, 1, "%")}</td>
                    <td className={o.winPctShift === null ? "" : o.winPctShift >= 0 ? "text-win" : "text-loss"}>{signed(o.winPctShift, 0, " pts")}</td>
                    <td>{signed(o.possessionShift, 0, " pts")}</td>
                    <td className="text-right text-xs">{o.topStyle ? `${o.topStyle.style} (${o.topStyle.n}${o.topStyle.winPct === null ? "" : `, ${o.topStyle.winPct.toFixed(0)}% W`})` : "Not tagged"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No active rivalries yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Career Football Indices</CardTitle>
          <CardDescription>Across every rival. N/A means that stat was not recorded.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border text-sm">
          {([
            ["Shot Clinical Index", n(lab.derived.shotClinical, 1, "%"), "goals per shot on target"],
            ["Build-Up Tempo", n(lab.derived.buildUpTempo, 2), "passes per possession-minute"],
            ["Progressive Directness", n(lab.derived.directness, 1, "%"), "crosses as % of passes"],
            ["Pressing Intensity", n(lab.derived.pressing, 1), "rival passes per defensive action, lower = harder press"],
            ["Save Efficiency", n(lab.derived.saveEfficiency, 1, "%"), "saves ÷ shots on target faced"],
          ] as const).map(([label, v, hint]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-2">
              <span>{label}<span className="block text-xs text-muted-foreground">{hint}</span></span>
              <span className="font-semibold tabular-nums">{v}</span>
            </div>
          ))}
          <div className="py-2 text-xs text-muted-foreground">
            {lab.rating.ready
              ? `Career Glicko-2 rating ${n(lab.rating.rating, 0)} ± ${lab.rating.rd === null ? NA : (lab.rating.rd * 2).toFixed(0)} (1500 is average).`
              : `Career rating unlocks at 10 matches (${lab.played} / 10).`}
            {lab.tilt.tiltedSessions > 0
              ? ` Tilt: ${lab.tilt.tiltedSessions} session(s) with two straight losses${lab.tilt.dropoff === null ? "" : `, ${signed(-lab.tilt.dropoff, 0)} pts afterwards`}.`
              : ""}
            {lab.summary.currentStreak ? ` Current run: ${lab.summary.currentStreak}.` : ""}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Career Personal Win Drivers</CardTitle>
          <CardDescription>Your own averages in the matches you won vs lost, across all rivals. Draws are left out.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-80 text-sm">
            <thead className="text-xs text-muted-foreground uppercase">
              <tr><th className="py-1 text-left">Stat</th><th>In wins</th><th>In losses</th><th>Lift</th><th className="text-right">r</th></tr>
            </thead>
            <tbody className="divide-y divide-border text-center tabular-nums">
              {lab.winDrivers.map((r) => (
                <tr key={r.stat}>
                  <td className="py-1 text-left">{r.label}</td>
                  <td>{n(r.winAvg, 1, pctStat(r.stat) ? "%" : "")}</td>
                  <td>{n(r.lossAvg, 1, pctStat(r.stat) ? "%" : "")}</td>
                  <td className={r.lift === null ? "" : r.lift >= 0 ? "text-win" : "text-loss"}>{signed(r.lift, 1)}</td>
                  <td className="text-right">{r.r === null ? NA : r.r.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
