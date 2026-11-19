"use client";

// What-if simulator: pure client-side maths (no AI, no network). Controls are
// bounded in the UI and clamped again inside simulateMatchScenario.

import { useId, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PLAYSTYLES, type Playstyle } from "@/lib/match-context";
import { type SimBaseline, type SimHost, type SimInputs, SIM_LIMITS, simulateMatchScenario } from "@/lib/match-simulator";

function Pills<T extends string>({ legend, options, value, onChange }: { legend: string; options: readonly (readonly [string, T | null])[]; value: T | null; onChange: (v: T | null) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([label, v]) => (
          <button key={label} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className="min-h-9 rounded-full border border-input px-3 text-sm aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground">
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Slider({ label, value, min, max, onChange, suffix = "" }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">{value}{suffix}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-primary" />
    </div>
  );
}

export function MatchSimulator({ baseline, meName, oppName, note }: { baseline: SimBaseline | null; meName: string; oppName: string; note?: string }) {
  const [mode, setMode] = useState<"prematch" | "live">("prematch");
  const [host, setHost] = useState<SimHost>(null);
  const [mine, setMine] = useState<Playstyle | null>(null);
  const [theirs, setTheirs] = useState<Playstyle | null>(null);
  const [minute, setMinute] = useState(45);
  const [myGoals, setMyGoals] = useState(0);
  const [oppGoals, setOppGoals] = useState(0);
  const [poss, setPoss] = useState(50);
  const [mySot, setMySot] = useState(0);
  const [oppSot, setOppSot] = useState(0);

  const inputs: SimInputs = { mode, host, myPlaystyle: mine, oppPlaystyle: theirs, minute, myGoals, oppGoals, myPossession: poss, mySot, oppSot };
  const r = useMemo(() => simulateMatchScenario(baseline, inputs), [baseline, mode, host, mine, theirs, minute, myGoals, oppGoals, poss, mySot, oppSot]); // eslint-disable-line react-hooks/exhaustive-deps
  const styles = PLAYSTYLES.map((p) => [p, p] as const);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>What-If Simulator</CardTitle>
        <CardDescription>
          Change the situation and see how the odds move. It runs on your own numbers, instantly, with no AI.{note ? ` ${note}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Pills legend="Mode" value={mode} onChange={(v) => setMode(v ?? "prematch")} options={[["Pre-match", "prematch"], ["Halftime / live", "live"]] as const} />
        <Pills legend="Who hosts" value={host} onChange={setHost} options={[["Neutral", null], [`${meName} hosts`, "me"], [`${oppName} hosts`, "opponent"]] as const} />
        <Pills legend="Your playstyle" value={mine} onChange={setMine} options={[["Any", null], ...styles] as const} />
        <Pills legend="Rival's playstyle" value={theirs} onChange={setTheirs} options={[["Any", null], ...styles] as const} />
        {mode === "live" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Slider label="Minute" value={minute} min={SIM_LIMITS.minute[0]} max={SIM_LIMITS.minute[1]} onChange={setMinute} />
            <Slider label="Your possession" value={poss} min={SIM_LIMITS.possession[0]} max={SIM_LIMITS.possession[1]} onChange={setPoss} suffix="%" />
            <Slider label={`${meName} goals`} value={myGoals} min={SIM_LIMITS.goals[0]} max={SIM_LIMITS.goals[1]} onChange={setMyGoals} />
            <Slider label={`${oppName} goals`} value={oppGoals} min={SIM_LIMITS.goals[0]} max={SIM_LIMITS.goals[1]} onChange={setOppGoals} />
            <Slider label="Your shots on target" value={mySot} min={SIM_LIMITS.sot[0]} max={SIM_LIMITS.sot[1]} onChange={setMySot} />
            <Slider label="Rival's shots on target" value={oppSot} min={SIM_LIMITS.sot[0]} max={SIM_LIMITS.sot[1]} onChange={setOppSot} />
          </div>
        ) : null}
        <div className="flex h-8 overflow-hidden rounded-md text-xs font-semibold" role="img" aria-label={`Final result: win ${r.win}%, draw ${r.draw}%, loss ${r.loss}%`}>
          <div className="flex items-center justify-center bg-win/70" style={{ width: `${r.win}%` }}>{r.win >= 8 ? `${r.win}%` : ""}</div>
          <div className="flex items-center justify-center bg-draw/70" style={{ width: `${r.draw}%` }}>{r.draw >= 8 ? `${r.draw}%` : ""}</div>
          <div className="flex items-center justify-center bg-loss/70" style={{ width: `${r.loss}%` }}>{r.loss >= 8 ? `${r.loss}%` : ""}</div>
        </div>
        <p className="text-xs text-muted-foreground">
          Final result: {meName} win {r.win}% · draw {r.draw}% · {oppName} win {r.loss}%. Most likely final score {r.likely.me}–{r.likely.opp} ({(r.likely.p * 100).toFixed(1)}%).
        </p>
        <p className="text-sm">{r.readout}</p>
      </CardContent>
    </Card>
  );
}
