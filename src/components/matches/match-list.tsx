"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { RivalryMatch } from "@/lib/match-helpers";
import { disputeMatchAction, resolveMatchDisputeAction } from "@/lib/match-actions";
import type { MatchOutcome } from "@/lib/match-stats";

const OUTCOME: Record<MatchOutcome, { label: string; className: string }> = {
  win: { label: "WIN", className: "bg-win/15 text-win" },
  draw: { label: "DRAW", className: "bg-draw/15 text-draw" },
  loss: { label: "LOSS", className: "bg-loss/15 text-loss" },
};

function Tag({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-semibold tracking-wide uppercase ${className}`}
    >
      {children}
    </span>
  );
}

export function MatchList({
  matches,
  opponentUsername,
}: {
  matches: RivalryMatch[];
  opponentUsername: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-2xl font-semibold tracking-wide uppercase">Recent Matches</h2>
      {matches.length ? (
        <ol className="flex flex-col gap-3">
          {matches.map((match) => (
            <li key={match.id}>
              <MatchCard match={match} opponentUsername={opponentUsername} />
            </li>
          ))}
        </ol>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 py-8 text-center">
            <p className="font-heading text-2xl font-semibold tracking-wide uppercase">
              No matches logged yet
            </p>
            <p className="text-sm text-muted-foreground">
              Add a match screenshot above to log your first result.
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function MatchCard({
  match,
  opponentUsername,
}: {
  match: RivalryMatch;
  opponentUsername: string;
}) {
  const outcome = OUTCOME[match.outcome];
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const disputed = match.status === "disputed";

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const r = await action();
      if (r.ok) router.refresh();
      else setError(r.error ?? "Something went wrong.");
    });
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-heading text-lg font-semibold text-muted-foreground">
            #{match.matchNo}
          </span>
          <Tag className={outcome.className}>{outcome.label}</Tag>
          {match.venue ? (
            <Tag className="bg-secondary text-secondary-foreground">
              {match.venue === "home" ? "Home" : "Away"}
            </Tag>
          ) : null}
          {match.decidedOnPens ? (
            <Tag className="bg-accent-pink/15 text-accent-pink">PENS</Tag>
          ) : null}
          {disputed ? (
            <Tag className="bg-loss/15 text-loss">DISPUTED</Tag>
          ) : match.needsReview ? (
            <Tag className="bg-draw/15 text-draw">REVIEW</Tag>
          ) : null}
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{match.myTeam}</p>
            <p className="text-xs text-muted-foreground">Me</p>
          </div>
          <p className="font-heading text-3xl font-bold whitespace-nowrap tabular-nums">
            {match.myGoals} – {match.opponentGoals}
          </p>
          <div className="min-w-0 text-right">
            <p className="truncate font-medium">{match.opponentTeam}</p>
            <p className="truncate text-xs text-muted-foreground">@{opponentUsername}</p>
          </div>
        </div>

        {match.remark ? (
          <p className="text-sm break-words text-muted-foreground">“{match.remark}”</p>
        ) : null}

        {disputed ? (
          <p className="text-xs text-muted-foreground">
            Disputed: this match is not counted in any stats until it is resolved.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {disputed ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => resolveMatchDisputeAction(match.id))}
            >
              Resolve / Confirm
            </Button>
          ) : !match.createdByMe ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (window.confirm("Dispute this match? It will stop counting until it is resolved.")) {
                  run(() => disputeMatchAction(match.id));
                }
              }}
            >
              Dispute
            </Button>
          ) : null}
          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
