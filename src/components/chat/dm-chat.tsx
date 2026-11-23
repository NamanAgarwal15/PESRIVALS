"use client";

// 1v1 chat view. Every message body is rendered as a plain React text node
// (whitespace-pre-wrap); there is no raw-HTML rendering anywhere here.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const MAX = 500;
const POLL_MS = 6000;

type Msg = { id: string; mine: boolean; body: string; createdAt: string };
type Thread = { messages: Msg[]; iBlockedThem: boolean; theyBlockedMe: boolean };

export function DmChat({ username, displayName }: { username: string; displayName: string }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const end = useRef<HTMLDivElement>(null);
  const url = `/api/chat/${encodeURIComponent(username)}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) setThread(data.thread);
      else setError(data.error ?? "Chat is unavailable.");
    } catch {
      setError("Could not reach the server.");
    }
  }, [url]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // Poll only while the tab is visible, to keep server load low.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [thread?.messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || body.length > MAX || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
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

  async function toggleBlock(blocked: boolean) {
    setError(null);
    const res = await fetch(`${url}/block`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocked }),
    }).catch(() => null);
    if (!res?.ok) setError("Could not update that.");
    await load();
  }

  const locked = thread?.iBlockedThem || thread?.theyBlockedMe;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Chat with {displayName}</p>
          {thread ? (
            thread.iBlockedThem ? (
              <Button type="button" size="sm" variant="outline" onClick={() => toggleBlock(false)}>
                Unblock messages
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => toggleBlock(true)}>
                Block Msgs Only (Keep Challenge Open)
              </Button>
            )
          ) : null}
        </div>

        <div className="flex max-h-96 min-h-48 flex-col gap-2 overflow-y-auto" aria-live="polite">
          {!thread ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {thread && !thread.messages.length ? (
            <p className="text-sm text-muted-foreground">No messages yet. Say hello.</p>
          ) : null}
          {thread?.messages.map((m) => (
            <div key={m.id} className={m.mine ? "flex justify-end" : "flex justify-start"}>
              <p
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                  m.mine ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}
              >
                {m.body}
              </p>
            </div>
          ))}
          <div ref={end} />
        </div>

        {thread?.iBlockedThem ? (
          <p className="text-sm text-muted-foreground">
            You blocked messages from this player. Challenges and matches still work as normal.
          </p>
        ) : null}
        {thread?.theyBlockedMe ? (
          <p className="text-sm text-muted-foreground">
            This player is not accepting messages. You can still challenge them.
          </p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

        <form onSubmit={send} className="flex gap-2">
          <label htmlFor={inputId} className="sr-only">Message</label>
          <textarea
            id={inputId}
            value={text}
            maxLength={MAX}
            rows={2}
            disabled={Boolean(locked)}
            onChange={(e) => setText(e.target.value)}
            className="min-h-10 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm"
            placeholder={locked ? "Messaging is off" : "Write a message (plain text)"}
          />
          <Button type="submit" disabled={busy || !text.trim() || Boolean(locked)}>
            Send
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{text.length}/{MAX}</p>
      </CardContent>
    </Card>
  );
}
