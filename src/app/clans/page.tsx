import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CreateClanForm, InviteList } from "@/components/clans/clan-ui";
import { BackLink } from "@/components/nav/back-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getMembership, listClans, listMyInvites } from "@/lib/clans";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Clans | PESRIVALS" };

export default function ClansPage({ searchParams }: PageProps<"/clans">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/leaderboard">← Back to Leaderboard</BackLink>
      <h1 className="text-3xl font-bold tracking-wide uppercase">Clans</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ClansContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ClansContent({ searchParams }: Pick<PageProps<"/clans">, "searchParams">) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.onboarded) redirect("/onboarding");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 40) : "";
  const [mine, invites, directory] = await Promise.all([getMembership(session.user.id), listMyInvites(session.user.id), listClans(q)]);
  return (
    <>
      {mine ? (
        <Card size="sm">
          <CardContent className="flex items-center justify-between gap-3">
            <span>You are {mine.role === "leader" ? "the leader" : `a ${mine.role}`} of <b>{mine.name}</b> [{mine.tag}]</span>
            <Link href={`/clans/${mine.tag}`} className="text-primary underline-offset-4 hover:underline">Open clan hub ›</Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {invites.length ? (
            <Card>
              <CardHeader><CardTitle>Invitations</CardTitle></CardHeader>
              <CardContent><InviteList invites={invites} /></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Start a clan</CardTitle>
              <CardDescription>Up to 25 players. Names, tags and descriptions are checked automatically; no links or abuse.</CardDescription>
            </CardHeader>
            <CardContent><CreateClanForm /></CardContent>
          </Card>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Clan directory</CardTitle>
          <form method="get" className="flex gap-2 pt-2">
            <input name="q" defaultValue={q} placeholder="Search by name or tag" maxLength={40} className="h-9 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm" />
            <button type="submit" className="rounded-lg border border-input px-3 text-sm">Search</button>
          </form>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {directory.length === 0 ? <p className="text-sm text-muted-foreground">No clans yet. Be the first.</p> : null}
          {directory.map((c) => (
            <Link key={c.tag} href={`/clans/${c.tag}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 text-sm last:border-0 hover:underline">
              <span><b>{c.name}</b> [{c.tag}]{c.description ? <span className="ml-2 text-muted-foreground">{c.description}</span> : null}</span>
              <span className="text-muted-foreground">{c.members}/25</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
