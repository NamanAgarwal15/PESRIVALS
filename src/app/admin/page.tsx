import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/nav/back-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  adminDeleteMatchAction,
  adminResolveSybilFlagAction,
  adminSetAnnouncementAction,
  adminSetPasswordAction,
  adminSetRoleAction,
  adminToggleLeaderboardAction,
  adminToggleSuspendAction,
} from "@/lib/admin-actions";
import {
  getAnnouncement,
  getPlatformStats,
  isAdminUser,
  listOpenSybilFlags,
  listRecentMatches,
  listUsers,
} from "@/lib/admin";
import { listAuditLogs } from "@/lib/audit";
import { getSession } from "@/lib/session";

export const metadata: Metadata = { title: "Admin | PESRIVALS", robots: { index: false } };

export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <main className="flex flex-1 flex-col gap-6">
      <BackLink href="/home">← Back to Home</BackLink>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <AdminContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function AdminContent({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  const session = await getSession();
  // Hidden from everyone but admins: a 404, not a "forbidden".
  if (!(await isAdminUser(session?.user?.id))) notFound();

  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const [stats, userRows, recent, announcement, flags, audit] = await Promise.all([
    getPlatformStats(),
    listUsers(q),
    listRecentMatches(),
    getAnnouncement(),
    listOpenSybilFlags(),
    listAuditLogs(),
  ]);
  const matchRows = (recent as unknown as { rows: Record<string, string | number>[] }).rows;
  const kpis: [string, number][] = [
    ["Total users", stats.users],
    ["Active rivalries", stats.activeRivalries],
    ["Total matches", stats.matches],
    ["Matches (7 days)", stats.matchesLast7Days],
  ];

  return (
    <>
      <h1 className="text-3xl font-bold tracking-wide uppercase">Admin</h1>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(([label, n]) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1">
              <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
              <span className="font-heading text-3xl font-bold tabular-nums">{n}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Global announcement banner</CardTitle>
          <CardDescription>Shown at the top of /home. Leave empty to disable.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={adminSetAnnouncementAction} className="flex flex-wrap gap-2">
            <Input name="text" defaultValue={announcement ?? ""} maxLength={280} className="h-10 min-w-60 flex-1" />
            <Button type="submit" className="h-10">Save</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users &amp; account recovery</CardTitle>
          <form className="flex gap-2 pt-2">
            <Input name="q" defaultValue={q} placeholder="Search username, name, email" className="h-10 flex-1" />
            <Button type="submit" variant="outline" className="h-10">Search</Button>
          </form>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {userRows.map((u) => (
            <div key={u.id} className="flex flex-col gap-2 border-b border-border/50 pb-4 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="font-semibold">@{u.username}</span>
                <span className="text-muted-foreground">{u.displayName}</span>
                <span>{u.email ?? "no email"}</span>
                <span className="uppercase">{u.role}</span>
                <span className={u.suspended ? "text-loss" : "text-win"}>
                  {u.suspended ? "suspended" : "active"}
                </span>
                <span className="text-muted-foreground">{u.matchCount} matches</span>
                <span className="text-muted-foreground">
                  peer profile: {u.publicLeaderboard ? "visible" : "private"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <form action={adminSetPasswordAction} className="flex gap-1">
                  <input type="hidden" name="userId" value={u.id} />
                  <Input name="password" type="text" placeholder="Temp password" className="h-8 w-40" required />
                  <Button type="submit" size="sm" variant="outline">Set temp password</Button>
                </form>
                <form action={adminToggleSuspendAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="suspended" value={String(!u.suspended)} />
                  <Button type="submit" size="sm" variant="outline">
                    {u.suspended ? "Unsuspend" : "Suspend"}
                  </Button>
                </form>
                <form action={adminToggleLeaderboardAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="visible" value={String(!u.publicLeaderboard)} />
                  <Button type="submit" size="sm" variant="outline">
                    {u.publicLeaderboard ? "Make profile private" : "Make profile visible"}
                  </Button>
                </form>
                <form action={adminSetRoleAction}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="role" value={u.role === "admin" ? "user" : "admin"} />
                  <Button type="submit" size="sm" variant="outline">
                    {u.role === "admin" ? "Revoke admin" : "Grant admin"}
                  </Button>
                </form>
              </div>
            </div>
          ))}
          {userRows.length === 0 ? <p className="text-sm text-muted-foreground">No users found.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Flagged activity (anti-sybil)</CardTitle>
          <CardDescription>Automatic checks only raise flags. Nothing is banned until you decide.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {flags.map((f) => (
            <form key={f.id} action={adminResolveSybilFlagAction} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-3 text-sm last:border-0">
              <input type="hidden" name="flagId" value={f.id} />
              <span className="min-w-0 flex-1">
                <b className={f.severity === "high" ? "text-loss" : "text-draw"}>{f.severity.toUpperCase()}</b>{" "}
                {f.flagType.replace(/_/g, " ")}: @{f.primary}
                {f.relatedUsername ? ` and @${f.relatedUsername}` : ""}
                <span className="block text-xs text-muted-foreground">{f.reason}</span>
              </span>
              <span className="flex gap-2">
                <Button type="submit" name="decision" value="dismiss" size="sm" variant="outline">Dismiss</Button>
                <Button type="submit" name="decision" value="suspend" size="sm" variant="destructive">Suspend @{f.primary}</Button>
              </span>
            </form>
          ))}
          {flags.length === 0 ? <p className="text-sm text-muted-foreground">No open flags.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent matches</CardTitle>
          <CardDescription>Remove fraudulent or corrupt entries (soft delete, logged).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {matchRows.map((m) => (
            <form key={String(m.id)} action={adminDeleteMatchAction} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 text-sm last:border-0">
              <input type="hidden" name="matchId" value={String(m.id)} />
              <span>
                @{m.aUser} {m.aTeam} <b className="tabular-nums">{m.aGoals}–{m.bGoals}</b> {m.bTeam} @{m.bUser}
                <span className="ml-2 text-muted-foreground">#{m.matchNo}</span>
              </span>
              <Button type="submit" size="sm" variant="destructive">Delete</Button>
            </form>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin audit log</CardTitle>
          <CardDescription>Append-only record of the latest 50 admin actions.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-96 text-sm">
            <thead className="text-left text-xs text-muted-foreground uppercase">
              <tr><th className="py-1">When</th><th>Admin</th><th>Action</th><th>Target</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="py-1 tabular-nums">{a.createdAt.toISOString().replace("T", " ").slice(0, 16)}</td>
                  <td>@{a.actor ?? "?"}</td>
                  <td>{a.action}</td>
                  <td className="font-mono text-xs">{a.targetType}:{a.targetId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {audit.length === 0 ? <p className="text-sm text-muted-foreground">No admin actions yet.</p> : null}
        </CardContent>
      </Card>
    </>
  );
}
