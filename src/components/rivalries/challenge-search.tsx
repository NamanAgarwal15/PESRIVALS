"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type RivalryActionState,
  type SearchState,
  respondToRivalryRequestAction,
  searchUsersAction,
  sendRivalryRequestAction,
} from "@/lib/rivalry-actions";
import type { UserSearchResult } from "@/lib/rivalry-helpers";
import { RivalryActionForm } from "./action-form";
import { PlayerIdentity } from "./player-identity";

const initialState: SearchState = {};

export function ChallengeSearch() {
  const [state, formAction, pending] = useActionState(searchUsersAction, initialState);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-2">
        <Label htmlFor="rival-search">Find a player by username</Label>
        <div className="flex gap-2">
          <Input
            id="rival-search"
            name="query"
            type="search"
            placeholder="@username"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={21}
            defaultValue={state.query ?? ""}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "rival-search-error" : undefined}
            className="h-11"
            required
          />
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            className="h-11 px-4 font-semibold"
          >
            {pending ? "Searching…" : "Search"}
          </Button>
        </div>
        {state.error ? (
          <p id="rival-search-error" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </form>

      {state.results ? (
        state.results.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {state.results.map((user) => (
              // Keyed by relation too, so a fresh search resets the row.
              <SearchResultRow key={`${user.id}:${user.relation}`} user={user} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No players found for “{state.query}”.
          </p>
        )
      ) : null}
    </div>
  );
}

function SearchResultRow({ user }: { user: UserSearchResult }) {
  // After an action succeeds, show the new relation without searching again.
  const [latest, setLatest] = useState<RivalryActionState | null>(null);
  const relation = latest?.ok && latest.relation ? latest.relation : user.relation;
  const rivalryId = latest?.ok && latest.rivalryId ? latest.rivalryId : user.rivalryId;

  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <PlayerIdentity displayName={user.displayName} username={user.username} />
      {relation === "active" && rivalryId ? (
        <Link
          href={`/rivalry/${rivalryId}`}
          className={buttonVariants({
            variant: "outline",
            size: "lg",
            className: "h-10 shrink-0 px-4 font-semibold",
          })}
        >
          Open Rivalry
        </Link>
      ) : relation === "pending_received" && rivalryId ? (
        <RivalryActionForm
          action={respondToRivalryRequestAction}
          fields={{ rivalryId, decision: "accept" }}
          label="Accept"
          pendingLabel="Accepting…"
          onResult={setLatest}
        />
      ) : relation === "pending_sent" ? (
        <Button disabled variant="outline" size="lg" className="h-10 shrink-0 px-4">
          Pending
        </Button>
      ) : relation === "blocked" ? (
        <Button disabled variant="outline" size="lg" className="h-10 shrink-0 px-4">
          Unavailable
        </Button>
      ) : (
        <RivalryActionForm
          action={sendRivalryRequestAction}
          fields={{ targetUserId: user.id }}
          label="Challenge"
          pendingLabel="Sending…"
          onResult={setLatest}
        />
      )}
    </li>
  );
}
