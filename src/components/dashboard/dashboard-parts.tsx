import type { MatchOutcome } from "@/lib/match-stats";

export function fmt(v: number | null, digits = 1): string {
  return v === null ? "—" : v.toFixed(digits);
}

export const FORM_CLASS: Record<MatchOutcome, string> = {
  win: "bg-win/15 text-win",
  draw: "bg-draw/15 text-draw",
  loss: "bg-loss/15 text-loss",
};

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="font-heading text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}
