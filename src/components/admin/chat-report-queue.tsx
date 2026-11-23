// Admin-only chat report queue. Server component; reported text is rendered as plain text nodes.
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminHideChatMessageAction, adminResolveChatReportAction } from "@/lib/admin-actions";
import type { AdminReportPage } from "@/lib/admin-chat";

const FILTERS = ["open", "reviewed", "dismissed", "all"] as const;
const href = (status: string, page: number) => `/admin?${new URLSearchParams({ rs: status, ...(page ? { rp: String(page) } : {}) })}#chat-reports`;

export function ChatReportQueue({ data, status }: { data: AdminReportPage; status: string }) {
  if (!data.ok) return null;
  return (
    <Card id="chat-reports">
      <CardHeader>
        <CardTitle>Chat reports ({data.openCount} open)</CardTitle>
        <CardDescription>
          Reports of lobby and 1v1 messages. Hiding a lobby message removes it for everyone and closes its reports. Opening this queue is recorded in the audit log.
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-2">
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={href(f, 0)}
              aria-current={status === f ? "true" : undefined}
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${status === f ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}
            >
              {f}
            </Link>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.rows.length === 0 ? <p className="text-sm text-muted-foreground">No reports here.</p> : null}
        {data.rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-2 border-b border-border/50 pb-3 text-sm last:border-0">
            <p className="text-xs text-muted-foreground">
              {r.kind === "global" ? "Lobby" : r.kind === "clan" ? "Clan chat" : "1v1"} · {r.reason} · @{r.reporter} reported @{r.reported} · {r.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {r.status}
              {r.hidden ? " · hidden" : ""}
            </p>
            <p className="rounded-md bg-muted px-3 py-2 break-words whitespace-pre-wrap">{r.body ?? "(message no longer available)"}</p>
            <div className="flex flex-wrap gap-2">
              {(r.kind === "global" || r.kind === "clan") && r.messageId ? (
                <form action={adminHideChatMessageAction}>
                  <input type="hidden" name="messageId" value={r.messageId} />
                  <input type="hidden" name="kind" value={r.kind} />
                  <input type="hidden" name="hidden" value={r.hidden ? "false" : "true"} />
                  <Button type="submit" size="sm" variant={r.hidden ? "outline" : "destructive"}>{r.hidden ? "Unhide" : "Hide message"}</Button>
                </form>
              ) : null}
              {r.status === "open" ? (
                <>
                  {(["reviewed", "dismissed"] as const).map((s) => (
                    <form key={s} action={adminResolveChatReportAction}>
                      <input type="hidden" name="reportId" value={r.id} />
                      <input type="hidden" name="status" value={s} />
                      <Button type="submit" size="sm" variant="outline">{s === "reviewed" ? "Mark reviewed" : "Dismiss"}</Button>
                    </form>
                  ))}
                </>
              ) : null}
            </div>
          </div>
        ))}
        <div className="flex justify-between text-sm">
          {data.page > 0 ? <Link href={href(status, data.page - 1)} className="text-primary hover:underline">← Newer</Link> : <span />}
          {data.hasMore ? <Link href={href(status, data.page + 1)} className="text-primary hover:underline">Older →</Link> : null}
        </div>
      </CardContent>
    </Card>
  );
}
