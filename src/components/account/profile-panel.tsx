"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PushSettings } from "@/components/push/push-settings";
import { CopyButton } from "@/components/profile/copy-button";
import { deleteMyAccountAction, linkGoogleAction, setProfileVisibilityAction, updateDisplayNameAction } from "@/lib/auth-actions";
import {
  type ProfileState,
  commitProfileChangeAction,
  updateEfootballIdAction,
  requestProfileOtpAction,
} from "@/lib/profile-actions";

type Kind = "password" | "email";

function ChangeSection({ kind, title, hasPassword }: { kind: Kind; title: string; hasPassword?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<ProfileState | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [needsCode, setNeedsCode] = useState(true);
  const [pending, start] = useTransition();

  function sendCode() {
    start(async () => {
      const r = await requestProfileOtpAction(kind);
      setMsg(r);
      if (r.ok) {
        setCodeSent(true);
        setNeedsCode(Boolean(r.needsCode));
      }
    });
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const r = await commitProfileChangeAction(kind, fd);
      setMsg(r);
      if (r.ok) {
        setCodeSent(false);
        setOpen(false);
        router.refresh();
      }
    });
  }

  const label = kind === "password" ? "New password" : "New email";
  return (
    <div className="flex flex-col gap-3 border-t border-border/50 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center justify-between text-left text-sm font-semibold"
      >
        {title}
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {msg?.message ? <p className="text-sm text-win">{msg.message}</p> : null}
      {msg?.error ? <p role="alert" className="text-sm text-destructive">{msg.error}</p> : null}
      {open ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          {(
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${kind}-value`}>{label}</Label>
              <Input
                id={`${kind}-value`}
                name="value"
                type={kind === "password" ? "password" : "email"}
                autoComplete={kind === "password" ? "new-password" : "email"}
                className="h-11"
                required
              />
            </div>
          )}
          {kind === "password" && hasPassword ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentPassword">Current password (or use a code below)</Label>
              <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" className="h-11" />
            </div>
          ) : null}
          {codeSent && needsCode ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${kind}-code`}>6-digit code</Label>
              <Input id={`${kind}-code`} name="code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" className="h-11" />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={sendCode} className="h-10">
              {codeSent ? "Resend code" : kind === "password" ? "Send code instead" : "Send verification code"}
            </Button>
            <Button type="submit" disabled={pending} className="h-10">
              {pending ? "Working…" : "Confirm change"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function NameRow({ initial }: { initial: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initial);
  const [shown, setShown] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await updateDisplayNameAction(name);
      if (r.ok) {
        setShown(r.value);
        setName(r.value);
        setEditing(false);
        router.refresh();
      } else setError(r.error);
    });
  }

  if (!editing) {
    return (
      <>
        <dd className="flex items-center gap-2">
          {shown}
          <button type="button" onClick={() => setEditing(true)} className="text-xs text-primary underline">
            Edit
          </button>
        </dd>
      </>
    );
  }
  return (
    <dd>
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          maxLength={50}
          className="h-9 w-48"
        />
        <Button type="submit" disabled={pending} className="h-9">Save</Button>
        <Button type="button" variant="outline" className="h-9" onClick={() => { setEditing(false); setName(shown); setError(null); }}>
          Cancel
        </Button>
      </form>
      {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
    </dd>
  );
}

function DataRightsSection() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
      <p className="text-sm font-semibold">Your data</p>
      <div className="flex flex-wrap gap-2">
        <a href="/api/account/export" download className="inline-flex h-10 items-center rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted">
          Export my data (JSON)
        </a>
        <Button type="button" variant="destructive" className="h-10" onClick={() => setOpen((v) => !v)}>
          Delete my account
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-muted-foreground">
            This removes your login, email and devices and renames you to “Deleted player”. Match results stay so your rivals keep their history. This cannot be undone. Type <strong>DELETE</strong> to confirm.
          </p>
          <Input aria-label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 w-40" />
          <Button
            type="button"
            variant="destructive"
            disabled={pending || typed !== "DELETE"}
            className="h-10"
            onClick={() => start(async () => { const r = await deleteMyAccountAction(typed); if (!r.ok) setError(r.error); })}
          >
            Permanently delete
          </Button>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function EfootballIdSection({ initial }: { initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial);
  const [msg, setMsg] = useState<ProfileState | null>(null);
  const [pending, start] = useTransition();

  function save(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const r = await updateEfootballIdAction(value);
      setMsg(r);
      if (r.ok) setSaved(r.value ?? null);
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2 border-t border-border/50 pt-3">
      <Label htmlFor="efootballId">eFootball ID (optional)</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="efootballId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={24}
          placeholder="Your in-game ID"
          className="h-10 w-56"
        />
        <Button type="submit" disabled={pending} className="h-10">Save</Button>
        {saved ? <CopyButton value={saved} label="Copy ID" /> : null}
      </div>
      <p className="text-xs text-muted-foreground">Shown on your profile so rivals can add you in the game.</p>
      {msg?.error ? <p role="alert" className="text-sm text-destructive">{msg.error}</p> : null}
      {msg?.message ? <p className="text-sm text-win">{msg.message}</p> : null}
    </form>
  );
}

export function ProfilePanel({
  username,
  displayName,
  email,
  hasPassword,
  efootballId,
  googleLinked,
  googleEnabled,
  peerVisible,
}: {
  username: string;
  displayName: string;
  email: string | null;
  hasPassword: boolean;
  efootballId: string | null;
  googleLinked: boolean;
  googleEnabled: boolean;
  peerVisible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(peerVisible);
  const [, start] = useTransition();

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="profile-security-panel"
        className="flex min-w-0 items-center gap-2 text-left"
      >
        <span className="min-w-0 truncate text-4xl font-bold tracking-wide">Hi @{username}</span>
        <span aria-hidden className="text-lg text-muted-foreground">{open ? "▴" : "▾"}</span>
        <span className="sr-only">Open Profile &amp; Security</span>
      </button>
      {open ? (
        <Card id="profile-security-panel" className="w-full max-w-xl">
          <CardContent className="flex flex-col gap-3">
            <h2 className="font-heading text-xl font-semibold tracking-wide uppercase">
              Profile &amp; Security
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Name</dt><NameRow initial={displayName} />
              <dt className="text-muted-foreground">Email</dt><dd>{email ?? "not set"}</dd>
              <dt className="text-muted-foreground">Google</dt>
              <dd className={googleLinked ? "text-win" : undefined}>{googleLinked ? "linked" : "not linked"}</dd>
            </dl>
            {!googleLinked && googleEnabled ? (
              <form action={linkGoogleAction}>
                <Button type="submit" variant="outline" className="h-10">Link Google Account</Button>
              </form>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {email
                ? "Changes are confirmed with a code sent to your email."
                : "Add an email so you can recover your account and receive login codes."}
            </p>
            <EfootballIdSection initial={efootballId} />
            <PushSettings />
            <ChangeSection kind="password" title="Change password" hasPassword={hasPassword} />
            <ChangeSection kind="email" title={email ? "Change email" : "Add email"} />
            <DataRightsSection />
            <label className="flex items-start gap-2 border-t border-border/50 pt-3 text-sm">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => {
                  setVisible(e.target.checked);
                  start(() => void setProfileVisibilityAction(e.target.checked));
                }}
                className="mt-1 h-4 w-4 accent-(--primary)"
              />
              <span>
                Let other players see my rivalries and match logs. My career stats stay public either way; my rivals and admins always see everything.
              </span>
            </label>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
