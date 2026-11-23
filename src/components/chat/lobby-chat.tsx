"use client";

// Global lobby. Every message body is rendered as a plain React text node
// (whitespace-pre-wrap); there is no raw-HTML rendering anywhere here.

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const MAX = 300;
const POLL_MS = 8000;
const REASONS = ["spam", "harassment", "hate", "links", "other"] as const;

type Msg = { id: string; mine: boolean; username: string; displayName: string; body: string; createdAt: string };

export function LobbyChat() {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const inputId = useId();
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/global", { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setMessages(data.messages);
      else setError(data.error ?? "The lobby is unavailable.");
    } catch {
      setError("Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages?.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || body.length > MAX || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/chat/global", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error ?? "Could not send that message.");
      else {
        setText("");
        await load();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function report(messageId: string, reason: string) {
    setReporting(null);
    setError(null);
    const res = await fetch("/api/chat/global/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, reason }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (data?.ok) setNotice("Thanks, an admin will review that message.");
    else setError(data?.error ?? "Could not send that report.");
  }

  async function blockMessages(username: string) {
    setError(null);
    const res = await fetch(`/api/chat/${encodeURIComponent(username)}/block`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocked: true }),
    }).catch(() => null);
    if (res?.ok) {
      setNotice(`Messages from @${username} are hidden. You can still challenge them.`);
      await load();
    } else setError("Could not update that.");
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Plain text only. Links, spam and abuse are blocked automatically. Be good to your rivals.
        </p>
        <div className="flex max-h-[28rem] min-h-56 flex-col gap-3 overflow-y-auto" aria-live="polite">
          {!messages ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {messages && !messages.length ? <p className="text-sm text-muted-foreground">Quiet in here. Say hello.</p> : null}
          {messages?.map((m) => (
            <div key={m.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
                <Link href={`/player/${m.username}`} className="font-medium text-foreground hover:underline">
                  {m.displayName}
                </Link>
                <span>@{m.username}</span>
                {!m.mine ? (
                  <span className="ml-auto flex gap-3">
                    <button type="button" className="hover:underline" onClick={() => setReporting(reporting === m.id ? null : m.id)}>
                      Report
                    </button>
                    <button type="button" className="hover:underline" onClick={() => blockMessages(m.username)}>
                      Block msgs
                    </button>
                  </span>
                ) : null}
              </div>
              <p className="rounded-lg bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap">{m.body}</p>
              {reporting === m.id ? (
                <div className="flex flex-wrap gap-2">
                  {REASONS.map((r) => (
                    <Button key={r} type="button" size="sm" variant="outline" onClick={() => report(m.id, r)}>
                      {r}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <div ref={end} />
        </div>

        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

        <form onSubmit={send} className="flex gap-2">
          <label htmlFor={inputId} className="sr-only">Message</label>
          <textarea
            id={inputId}
            value={text}
            maxLength={MAX}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            className="min-h-10 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm"
            placeholder="Say something to the lobby (plain text)"
          />
          <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
        </form>
        <p className="text-xs text-muted-foreground">{text.length}/{MAX}</p>
      </CardContent>
    </Card>
  );
}
