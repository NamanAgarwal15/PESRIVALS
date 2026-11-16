import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  cancelRivalryRequestAction,
  respondToRivalryRequestAction,
} from "@/lib/rivalry-actions";
import type { RivalrySummary } from "@/lib/rivalry-helpers";
import { RivalryActionForm } from "./action-form";
import { ChallengeSearch } from "./challenge-search";
import { PlayerIdentity } from "./player-identity";

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-2 text-2xl font-semibold tracking-wide uppercase">
        {title}
        {count ? (
          <span className="font-sans text-sm font-medium text-muted-foreground normal-case">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

export function ChallengeSection() {
  return (
    <Section title="Challenge a Friend">
      <Card>
        <CardContent>
          <ChallengeSearch />
        </CardContent>
      </Card>
    </Section>
  );
}

export function IncomingRequestsSection({ requests }: { requests: RivalrySummary[] }) {
  if (!requests.length) return null;
  return (
    <Section title="Incoming Requests" count={requests.length}>
      {requests.map((request) => (
        <Card key={request.id} size="sm" className="ring-primary/40">
          <CardContent className="flex flex-col gap-3">
            <PlayerIdentity
              displayName={request.opponent.displayName}
              username={request.opponent.username}
              detail="wants a rivalry"
            />
            <div className="flex gap-2">
              <RivalryActionForm
                action={respondToRivalryRequestAction}
                fields={{ rivalryId: request.id, decision: "accept" }}
                label="Accept"
                pendingLabel="Accepting…"
              />
              <RivalryActionForm
                action={respondToRivalryRequestAction}
                fields={{ rivalryId: request.id, decision: "decline" }}
                label="Decline"
                pendingLabel="Declining…"
                variant="outline"
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </Section>
  );
}

export function SentRequestsSection({ requests }: { requests: RivalrySummary[] }) {
  if (!requests.length) return null;
  return (
    <Section title="Sent Requests" count={requests.length}>
      {requests.map((request) => (
        <Card key={request.id} size="sm">
          <CardContent className="flex items-center gap-3">
            <PlayerIdentity
              displayName={request.opponent.displayName}
              username={request.opponent.username}
              detail="waiting"
            />
            <RivalryActionForm
              action={cancelRivalryRequestAction}
              fields={{ rivalryId: request.id }}
              label="Cancel"
              pendingLabel="Cancelling…"
              variant="outline"
            />
          </CardContent>
        </Card>
      ))}
    </Section>
  );
}

const matchesLabel = (count: number) => `${count} ${count === 1 ? "match" : "matches"}`;

export function ActiveRivalriesSection({ rivalries }: { rivalries: RivalrySummary[] }) {
  return (
    <Section title="Active Rivalries" count={rivalries.length}>
      {rivalries.length ? (
        rivalries.map((rivalry) => (
          <Link
            key={rivalry.id}
            href={`/rivalry/${rivalry.id}`}
            className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Card size="sm" className="transition-colors hover:bg-secondary/40">
              <CardContent className="flex items-center gap-3">
                <PlayerIdentity
                  displayName={rivalry.opponent.displayName}
                  username={rivalry.opponent.username}
                  detail={matchesLabel(rivalry.matchCount)}
                />
                <span aria-hidden className="text-xl text-primary">
                  ›
                </span>
              </CardContent>
            </Card>
          </Link>
        ))
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 py-8 text-center">
            <p className="font-heading text-2xl font-semibold tracking-wide uppercase">
              No rivalries yet
            </p>
            <p className="text-sm text-muted-foreground">
              Challenge a friend above to start your first 1v1 rivalry.
            </p>
          </CardContent>
        </Card>
      )}
    </Section>
  );
}
