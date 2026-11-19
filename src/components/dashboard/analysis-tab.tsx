import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DerivedIndicesCard, EdaLab } from "@/components/dashboard/eda-lab";
import { MatchLab } from "@/components/dashboard/match-lab";
import {
  ChartTeams,
  CoreStatBars,
  GoalsTrendChart,
  MomentumChart,
  PlaystyleRadar,
} from "@/components/dashboard/rivalry-charts";
import type { computeRivalryAnalytics } from "@/lib/rivalry-analytics";

export function AnalysisTab({
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
