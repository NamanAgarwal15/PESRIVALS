"use client";

// Client pieces for clans. All user text is rendered as plain React text nodes;
// there is no raw-HTML rendering anywhere in this file. Permissions are enforced
// by the API; the buttons here are only shown to the roles that can use them.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    return await res.json();
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>, onOk?: (r: Record<string, unknown>) => void) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setError(r.error ?? "Something went wrong.");
    else if (onOk) onOk(r);
    else router.refresh();
  };
  return { error, busy, run, router };
}

const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null);

export function CreateClanForm() {
  const { error, busy, run, router } = useAction();
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => call("/api/clans", "POST", { name, tag, description }), (r) => router.push(`/clans/${r.tag}`));
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Clan name (3-40 characters)" aria-label="Clan name" required />
        <Input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase())} maxLength={6} placeholder="TAG" aria-label="Clan tag" required />
      </div>
      <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Description (optional)" aria-label="Description" />
      <Err error={error} />
      <Button type="submit" disabled={busy || !name.trim() || !tag.trim()} className="self-start">Create clan</Button>
    </form>
  );
}

export function InviteList({ invites }: { invites: { id: string; clanTag: string; clanName: string }[] }) {
  const { error, busy, run, router } = useAction();
  if (!invites.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {invites.map((i) => (
        <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{i.clanName} [{i.clanTag}] invited you</span>
          <span className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(() => call("/api/clan-invites", "POST", { inviteId: i.id, accept: true }), (r) => router.push(`/clans/${r.tag}`))}>Join</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => call("/api/clan-invites", "POST", { inviteId: i.id, accept: false }))}>Decline</Button>
          </span>
        </div>
      ))}
      <Err error={error} />
    </div>
  );
}

type Member = { username: string; displayName: string; role: "leader" | "officer" | "member" };

export function RosterManage({ tag, myRole, members, myUsername }: { tag: string; myRole: "leader" | "officer" | "member"; members: Member[]; myUsername: string }) {
  const { error, busy, run, router } = useAction();
  const [invitee, setInvitee] = useState("");
  const url = `/api/clans/${tag}/manage`;
  const act = (body: Record<string, unknown>, then?: () => void) => run(() => call(url, "POST", body), then ? () => then() : undefined);
  const officer = myRole === "leader" || myRole === "officer";
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {members.map((m) => {
          const isMe = m.username === myUsername;
          const canKick = !isMe && m.role !== "leader" && (myRole === "leader" || (myRole === "officer" && m.role === "member"));
          return (
            <li key={m.username} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link href={`/player/${m.username}`} className="hover:underline">
                {m.displayName} <span className="text-muted-foreground">@{m.username}</span>
              </Link>
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground uppercase">{m.role}</span>
                {myRole === "leader" && !isMe ? (
                  <>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "role", username: m.username, role: m.role === "officer" ? "member" : "officer" })}>
                      {m.role === "officer" ? "Demote" : "Make officer"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(`Hand the clan to @${m.username}?`) && act({ action: "transfer", username: m.username })}>
                      Make leader
                    </Button>
                  </>
                ) : null}
                {canKick ? (
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => confirm(`Remove @${m.username}?`) && act({ action: "kick", username: m.username })}>
                    Remove
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {officer ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "invite", username: invitee.trim().replace(/^@/, "") }, () => {
              setInvitee("");
              router.refresh();
            });
          }}
        >
          <Input value={invitee} onChange={(e) => setInvitee(e.target.value)} placeholder="Invite by username" aria-label="Invite by username" maxLength={21} />
          <Button type="submit" disabled={busy || !invitee.trim()}>Invite</Button>
        </form>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm("Leave this clan?") && run(() => call(url, "POST", { action: "leave" }), () => router.push("/clans"))}>
          Leave clan
        </Button>
        {myRole === "leader" ? (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => confirm("Disband the clan for everyone?") && run(() => call(url, "POST", { action: "disband" }), () => router.push("/clans"))}>
            Disband
          </Button>
        ) : null}
      </div>
      <Err error={error} />
    </div>
  );
}

type Msg = { id: string; mine: boolean; username: string; displayName: string; body: string };

export function ClanChat({ tag }: { tag: string }) {
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const r = await call(`/api/clans/${tag}/chat`, "GET");
    if (r.ok) setMessages(r.messages as Msg[]);
    else setError(r.error ?? "Chat is unavailable.");
  }, [tag]);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages?.length]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-h-80 min-h-40 flex-col gap-2 overflow-y-auto" aria-live="polite">
        {!messages ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {messages && !messages.length ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
        {messages?.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{m.displayName} @{m.username}</span>
            <p className={`rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap ${m.mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{m.body}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <Err error={error} />
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          setError(null);
          const r = await call(`/api/clans/${tag}/chat`, "POST", { body: text });
          setBusy(false);
          if (r.ok) {
            setText("");
            await load();
          } else setError(r.error ?? "Could not send that message.");
        }}
      >
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea id={id} value={text} maxLength={300} rows={2} onChange={(e) => setText(e.target.value)} placeholder="Message your clan (plain text)" className="min-h-10 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm" />
        <Button type="submit" disabled={busy || !text.trim()}>Send</Button>
      </form>
    </div>
  );
}

export function WarChallengeForm({ tag, myMembers }: { tag: string; myMembers: string[] }) {
  const { error, busy, run } = useAction();
  const [defenderTag, setDefenderTag] = useState("");
  const [size, setSize] = useState<3 | 5>(3);
  const [pairs, setPairs] = useState<{ mine: string; theirs: string }[]>(() => Array.from({ length: 5 }, () => ({ mine: "", theirs: "" })));
  const set = (i: number, k: "mine" | "theirs", v: string) => setPairs((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => call(`/api/clans/${tag}/wars`, "POST", { defenderTag, seriesSize: size, pairings: pairs.slice(0, size) }));
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input value={defenderTag} onChange={(e) => setDefenderTag(e.target.value.toUpperCase())} maxLength={6} placeholder="Enemy clan TAG" aria-label="Enemy clan tag" className="w-40" required />
        <select value={size} onChange={(e) => setSize(Number(e.target.value) as 3 | 5)} aria-label="Series size" className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm">
          <option value={3}>Best of 3</option>
          <option value={5}>Best of 5</option>
        </select>
      </div>
      {pairs.slice(0, size).map((p, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-2">
          <select value={p.mine} onChange={(e) => set(i, "mine", e.target.value)} aria-label={`Game ${i + 1}: your player`} className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm" required>
            <option value="">Game {i + 1}: your player</option>
            {myMembers.map((m) => <option key={m} value={m}>@{m}</option>)}
          </select>
          <Input value={p.theirs} onChange={(e) => set(i, "theirs", e.target.value.replace(/^@/, ""))} placeholder="their username" aria-label={`Game ${i + 1}: their player`} maxLength={20} required />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Each pair settles on a confirmed, decisive match between those two players, saved after the war starts. They need an active rivalry with each other.</p>
      <Err error={error} />
      <Button type="submit" disabled={busy || !defenderTag.trim()} className="self-start">Send challenge</Button>
    </form>
  );
}

export function WarActions({ warId, canAccept, canCancel }: { warId: string; canAccept: boolean; canCancel: boolean }) {
  const { error, busy, run } = useAction();
  if (!canAccept && !canCancel) return null;
  const go = (action: string) => run(() => call(`/api/clan-wars/${warId}`, "POST", { action }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canAccept ? (
        <>
          <Button size="sm" disabled={busy} onClick={() => go("accept")}>Accept war</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => go("decline")}>Decline</Button>
        </>
      ) : null}
      {canCancel ? <Button size="sm" variant="outline" disabled={busy} onClick={() => go("cancel")}>Cancel challenge</Button> : null}
      <Err error={error} />
    </div>
  );
}
