// Admin-only reader for every persisted Rivalry Coach chat. Server component;
// all text is rendered as plain text nodes. Never shows system prompts or keys.
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AdminChatPage } from "@/lib/admin-coach";

function href(filter: "all" | "flagged", user: string, page: number) {
  const p = new URLSearchParams();
  if (filter === "flagged") p.set("chat", "flagged");
  if (user) p.set("cu", user);
  if (page > 0) p.set("cp", String(page));
  const qs = p.toString();
  return `/admin${qs ? `?${qs}` : ""}#coach-chats`;
}

export function CoachChatReader({ data, filter, user }: { data: AdminChatPage; filter: "all" | "flagged"; user: string }) {
  return (
    <Card id="coach-chats">
      <CardHeader>
        <CardTitle>Rivalry Coach chats</CardTitle>
        <CardDescription>
          Every AI coach conversation, newest first. Opening this section is recorded in the audit log.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          {(["all", "flagged"] as const).map((f) => (
            <Link
              key={f}
              href={href(f, user, 0)}
              aria-current={filter === f ? "true" : undefined}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
            >
              {f === "all" ? "All Chats" : "Flagged Only"}
            </Link>
          ))}
          <form method="get" action="/admin#coach-chats" className="flex gap-2">
            {filter === "flagged" ? <input type="hidden" name="chat" value="flagged" /> : null}
            <Input name="cu" defaultValue={user} placeholder="Filter by username" className="h-8 w-44" />
            <Button type="submit" size="sm" variant="outline">Filter</Button>
          </form>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.ok ? (
          <>
            <p className="text-xs text-muted-foreground">
              {data.total} {data.total === 1 ? "chat" : "chats"}
              {filter === "flagged" ? " flagged" : ""}
              {user ? ` for “${user}”` : ""}. Page {data.page + 1}.
            </p>
            {data.rows.map((r) => (
              <article key={r.id} className="flex flex-col gap-2 rounded-lg bg-secondary/40 p-3 text-sm">
                <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">@{r.username}</span>
                  <span>{r.displayName}</span>
                  <span>{r.scope}</span>
                  <time dateTime={r.createdAt.toISOString()}>{r.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC</time>
                  <span className="rounded-md bg-secondary px-2 py-0.5 font-semibold uppercase">{r.source}</span>
                  {r.flagged ? <span className="rounded-md bg-loss/15 px-2 py-0.5 font-semibold text-loss uppercase">Flagged{r.flagReason ? `: ${r.flagReason}` : ""}</span> : null}
                </header>
                <p className="whitespace-pre-wrap"><b>User:</b> {r.userMessage}</p>
                <p className="whitespace-pre-wrap"><b>Coach:</b> {r.assistantReply}</p>
              </article>
            ))}
            {data.rows.length === 0 ? <p className="text-sm text-muted-foreground">No chats match.</p> : null}
            <div className="flex gap-3 text-sm">
              {data.page > 0 ? <Link href={href(filter, user, data.page - 1)} className="underline underline-offset-4">← Newer</Link> : null}
              {data.hasMore ? <Link href={href(filter, user, data.page + 1)} className="underline underline-offset-4">Older →</Link> : null}
            </div>
          </>
        ) : (
          <p role="alert" className="text-sm text-destructive">{data.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
