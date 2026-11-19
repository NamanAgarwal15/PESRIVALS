"use client";

// Persistent banner shown until browser notifications are on. It has no
// dismiss button on purpose: alerts about disputes and challenges matter.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { enablePush, fetchPushInfo, getLocalSubscription, pushSupported } from "./push-client";

type State = "checking" | "hidden" | "prompt" | "blocked";

export function PushBanner() {
  const [state, setState] = useState<State>("checking");
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) return void (!cancelled && setState("hidden"));
      const info = await fetchPushInfo();
      if (cancelled) return;
      if (!info?.configured || !info.publicKey) return setState("hidden");
      setKey(info.publicKey);
      if ((await getLocalSubscription()) && Notification.permission === "granted") return setState("hidden");
      setState(Notification.permission === "denied" ? "blocked" : "prompt");
    })().catch(() => !cancelled && setState("hidden"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking" || state === "hidden") return null;

  async function turnOn() {
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const err = await enablePush(key);
      if (err) {
        setError(err);
        setState(Notification.permission === "denied" ? "blocked" : "prompt");
      } else setState("hidden");
    } catch {
      setError("Could not enable notifications. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/50 bg-primary/10 px-4 py-3 text-sm">
      <p className="min-w-0 flex-1">
        {state === "blocked"
          ? "Notifications are blocked for this site. Allow them in your browser settings so you never miss a dispute or challenge."
          : "Turn on notifications so you instantly know when a rival logs, disputes or challenges you."}
        {error ? <span className="mt-1 block text-destructive">{error}</span> : null}
      </p>
      {state === "prompt" ? (
        <Button type="button" onClick={turnOn} disabled={busy} className="h-10">
          {busy ? "Enabling…" : "Enable notifications"}
        </Button>
      ) : null}
    </div>
  );
}
