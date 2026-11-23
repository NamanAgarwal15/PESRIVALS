import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { ClanChat, RosterManage, WarActions, WarChallengeForm } from "@/components/clans/clan-ui";
import { BackLink } from "@/components/nav/back-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getClanWars } from "@/lib/clan-wars";
import { getClanHub } from "@/lib/clans";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Clan | PESRIVALS" };

export default function ClanPage({ params }: PageProps<"/clans/[tag]">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/clans">← Back to Clans</BackLink>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ClanContent params={params} />
      </Suspense>
    </main>
  );
}

async function ClanContent({ params }: Pick<PageProps<"/clans/[tag]">, "params">) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  const { tag } = await params;
  const hub = await getClanHub(session.user.id, decodeURIComponent(tag));
  if (!hub) notFound();
  const [wars, [me]] = await Promise.all([
    getClanWars(hub.clan.id, hub.myRole),
    db.select({ username: users.username }).from(users).where(eq(users.id, session.user.id)),
  ]);
  const officer = hub.myRole === "leader" || hub.myRole === "officer";

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="truncate text-4xl font-bold tracking-wide">{hub.clan.name} <span className="text-muted-foreground">[{hub.clan.tag}]</span></h1>
        {hub.clan.description ? <p className="text-muted-foreground">{hub.clan.description}</p> : null}
      </header>

      <Card>
        <CardHeader><CardTitle>Roster ({hub.members.length}/25)</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {hub.myRole && me ? (
            <RosterManage tag={hub.clan.tag} myRole={hub.myRole} members={hub.members} myUsername={me.username} />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {hub.members.map((m) => (
                <li key={m.username}>{m.displayName} <span className="text-muted-foreground">@{m.username} · {m.role}</span></li>
              ))}
            </ul>
          )}
          {officer && hub.invites.length ? (
            <p className="text-xs text-muted-foreground">Pending invites: {hub.invites.map((i) => `@${i.username}`).join(", ")}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clan Wars</CardTitle>
          <CardDescription>Best-of-3 or best-of-5 series. Each game is a player-vs-player pairing settled by a confirmed, decisive match.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {wars.length === 0 ? <p className="text-sm text-muted-foreground">No wars yet.</p> : null}
          {wars.map((w) => (
            <div key={w.id} className="flex flex-col gap-2 border-b border-border/50 pb-4 text-sm last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b>
                  {w.challenger.name} [{w.challenger.tag}] <span className="tabular-nums">{w.challenger.wins}–{w.defender.wins}</span> {w.defender.name} [{w.defender.tag}]
                </b>
                <span className="text-xs text-muted-foreground uppercase">
                  Bo{w.seriesSize} · {w.status}{w.winnerTag ? ` · winner ${w.winnerTag}` : ""}
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {w.pairings.map((p) => (
                  <li key={p.slot} className="flex flex-wrap justify-between gap-2">
                    <span>Game {p.slot}: @{p.challenger} vs @{p.defender}</span>
                    <span className="text-muted-foreground">{p.status === "completed" ? `won by @${p.winner ?? "?"}` : "waiting for a confirmed result"}</span>
                  </li>
                ))}
              </ul>
              <WarActions warId={w.id} canAccept={w.canAccept} canCancel={w.canCancel} />
            </div>
          ))}
          {officer ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Challenge another clan</h3>
              <WarChallengeForm tag={hub.clan.tag} myMembers={hub.members.map((m) => m.username)} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {hub.myRole ? (
        <Card>
          <CardHeader>
            <CardTitle>Clan chat</CardTitle>
            <CardDescription>Private to this clan. Plain text; links and abuse are blocked.</CardDescription>
          </CardHeader>
          <CardContent><ClanChat tag={hub.clan.tag} /></CardContent>
        </Card>
      ) : null}
    </>
  );
}
