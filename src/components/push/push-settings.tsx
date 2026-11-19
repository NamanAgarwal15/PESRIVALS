"use client";

// Profile & Security: enable notifications, or turn them off through three
// deliberate steps (intent -> consequences -> typed confirmation).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disablePush, enablePush, fetchPushInfo, getLocalSubscription, pushSupported } from "./push-client";

type Phase = "loading" | "unsupported" | "off" | "on";

export function PushSettings() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [key, setKey] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) return void (!cancelled && setPhase("unsupported"));
      const info = await fetchPushInfo();
      if (cancelled) return;
      if (!info?.configured || !info.publicKey) return setPhase("unsupported");
      setKey(info.publicKey);
      setPhase((await getLocalSubscription()) && Notification.permission === "granted" ? "on" : "off");
    })().catch(() => !cancelled && setPhase("unsupported"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      const err = await enablePush(key);
      if (err) setMsg(err);
      else setPhase("on");
    } catch {
      setMsg("Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMsg(null);
    try {
      const err = await disablePush();
      if (err) setMsg(err);
      else {
        setPhase("off");
        setStep(0);
        setTyped("");
      }
    } catch {
      setMsg("Could not disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading" || phase === "unsupported") return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
      <p className="text-sm font-semibold">Notifications</p>
      {phase === "off" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-muted-foreground">Off: you will not hear about disputes, new matches or challenges.</p>
          <Button type="button" onClick={turnOn} disabled={busy} className="h-10">Enable notifications</Button>
        </div>
      ) : step === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-win">On</span>
          <Button type="button" variant="outline" onClick={() => setStep(1)} className="h-9">Turn off…</Button>
        </div>
      ) : step === 1 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">Step 1 of 3: Do you really want to stop notifications?</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setStep(0)} className="h-9">Keep them on</Button>
            <Button type="button" variant="outline" onClick={() => setStep(2)} className="h-9">Continue</Button>
          </div>
        </div>
      ) : step === 2 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">Step 2 of 3: You will miss rival disputes, match alerts and challenges. A disputed match stays out of your stats until someone resolves it.</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setStep(0)} className="h-9">Keep them on</Button>
            <Button type="button" variant="outline" onClick={() => setStep(3)} className="h-9">I understand, continue</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">Step 3 of 3: Type <strong>DISABLE</strong> to confirm.</p>
          <Input aria-label="Type DISABLE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 w-40" />
          <div className="flex gap-2">
            <Button type="button" onClick={() => { setStep(0); setTyped(""); }} className="h-9">Keep them on</Button>
            <Button type="button" variant="outline" disabled={busy || typed.trim() !== "DISABLE"} onClick={turnOff} className="h-9">Turn off notifications</Button>
          </div>
        </div>
      )}
      {msg ? <p role="alert" className="text-sm text-destructive">{msg}</p> : null}
    </div>
  );
}
