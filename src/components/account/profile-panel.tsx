"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { linkGoogleAction, setProfileVisibilityAction } from "@/lib/auth-actions";
import {
  type ProfileState,
  commitProfileChangeAction,
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

export function ProfilePanel({
  username,
  displayName,
  email,
  hasPassword,
  googleLinked,
  googleEnabled,
  peerVisible,
}: {
  username: string;
  displayName: string;
  email: string | null;
  hasPassword: boolean;
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
              <dt className="text-muted-foreground">Name</dt><dd>{displayName}</dd>
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
            <ChangeSection kind="password" title="Change password" hasPassword={hasPassword} />
            <ChangeSection kind="email" title={email ? "Change email" : "Add email"} />
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
                Let other players inspect my profile and rivalry details. Admins can always see them for moderation.
              </span>
            </label>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
