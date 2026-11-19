"use client";

// Browser-side Web Push helpers shared by the banner and Profile & Security.

export type PushInfo = { configured: boolean; publicKey: string | null };

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function keyToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function fetchPushInfo(): Promise<PushInfo | null> {
  try {
    const res = await fetch("/api/push/subscribe", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { configured?: boolean; publicKey?: string | null };
    return { configured: Boolean(j.configured), publicKey: j.publicKey ?? null };
  } catch {
    return null;
  }
}

export async function getLocalSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks permission, subscribes, and stores the subscription. Returns an error message or null. */
export async function enablePush(publicKey: string): Promise<string | null> {
  if (!pushSupported()) return "This browser does not support notifications.";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications are blocked. Allow them in your browser's site settings.";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok ? null : "Could not enable notifications. Try again.";
}

export async function disablePush(): Promise<string | null> {
  const sub = await getLocalSubscription();
  if (!sub) return null;
  const res = await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe().catch(() => false);
  return res.ok ? null : "Could not disable notifications. Try again.";
}
