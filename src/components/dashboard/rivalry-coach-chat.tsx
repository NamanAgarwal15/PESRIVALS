"use client";

// Scoped Rivalry Coach chat. All text is rendered as plain React text nodes:
// there is no raw-HTML rendering anywhere in this component.

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const MAX = 300;
const STARTERS = ["Why do I lose to my top rival?", "What stats drive my wins?", "Compare my rivals", "Gameplan for next match"];

type Turn = { role: "user" | "assistant"; content: string };

export type CoachQuotaInfo = { limit: number; remaining: number; resetsAt: string; aiEnabled: boolean };

export const QUOTA_EXHAUSTED_NOTICE =
  "Daily AI Coach limit reached — resets at midnight UTC. Instant rule-based tips & What-If Simulator remain available.";

export function RivalryCoachChat({ rivalryId, initialQuota = null }: { rivalryId?: string; initialQuota?: CoachQuotaInfo | null }) {
  const [quota, setQuota] = useState<CoachQuotaInfo | null>(initialQuota);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const end = useRef<HTMLDivElement>(null);

  const exhausted = quota !== null && quota.aiEnabled && quota.remaining <= 0;

  async function ask(question: string, free = false) {
    if (free && exhausted) return;
    const q = question.trim();
    if (!q || q.length > MAX || busy) return;
    setBusy(true);
    setError(null);
    const history = turns.slice(-6);
    setTurns((t) => [...t, { role: "user", content: q }]);
    setText("");
    try {
      const res = await fetch("/api/coach/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history, rivalryId }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; reply?: string; error?: string; remainingToday?: number; limit?: number; resetsAt?: string; aiEnabled?: boolean } | null;
      if (j && typeof j.remainingToday === "number" && typeof j.limit === "number") {
        setQuota({ limit: j.limit, remaining: j.remainingToday, resetsAt: j.resetsAt ?? "", aiEnabled: j.aiEnabled !== false });
      }
      if (j?.ok && typeof j.reply === "string") {
        const reply = j.reply;
        setTurns((t) => [...t, { role: "assistant", content: reply }]);
      } else setError(j?.error ?? "The coach is unavailable right now.");
    } catch {
      setError("Could not reach the coach. Check your connection.");
    } finally {
      setBusy(false);
      setTimeout(() => end.current?.scrollIntoView({ block: "nearest" }), 0);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Rivalry Coach</CardTitle>
        <CardDescription>Ask about your own matches, playstyles and stats. The coach only sees your confirmed matches and can make mistakes, so treat it as guidance.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {quota ? (
          <p data-testid="coach-quota" className={`self-start rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ${exhausted ? "bg-loss/15 text-loss" : "bg-secondary text-secondary-foreground"}`}>
            {quota.aiEnabled ? `${Math.max(0, quota.remaining)} / ${quota.limit} AI asks left today` : "Rule-based coach (AI is not set up)"}
          </p>
        ) : null}
        {exhausted ? (
          <p role="status" className="rounded-lg border border-draw/50 bg-draw/10 px-3 py-2 text-sm">{QUOTA_EXHAUSTED_NOTICE}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => ask(s)} className="min-h-9 rounded-full border border-input px-3 text-sm hover:bg-secondary disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-live="polite">
          {turns.map((t, i) => (
            <p key={i} className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${t.role === "user" ? "self-end bg-primary/15" : "self-start bg-secondary/60"}`}>
              {t.content}
            </p>
          ))}
          {busy ? <p className="self-start text-sm text-muted-foreground">Thinking…</p> : null}
          <div ref={end} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text, true);
          }}
          className="flex flex-col gap-1"
        >
          <label htmlFor={inputId} className="sr-only">Ask the coach</label>
          <div className="flex gap-2">
            <input id={inputId} value={text} maxLength={MAX} disabled={exhausted} onChange={(e) => setText(e.target.value)} placeholder={exhausted ? "AI limit reached for today" : "Ask your coach…"} className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm" />
            <Button type="submit" disabled={busy || exhausted || !text.trim()} className="h-11">Ask</Button>
          </div>
          <span className={`self-end text-xs tabular-nums ${text.length >= MAX ? "text-destructive" : "text-muted-foreground"}`}>{text.length}/{MAX}</span>
        </form>
      </CardContent>
    </Card>
  );
}
