// Web Push: endpoint validation (SSRF guard), encrypted storage and sending.
// Framework-free. Sending never throws: a failed push must not break a match save.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import * as webpush from "web-push";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { securityLog } from "@/lib/security-log";

// ---------------------------------------------------------------------------
// Endpoint validation (A01 / SSRF)
// ---------------------------------------------------------------------------

/** True for loopback, private, link-local, unspecified and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224
    );
  }
  if (v === 6) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    // URL parsing rewrites ::ffff:1.2.3.4 as ::ffff:102:304 (hex), so decode that too.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff");
  }
  return false;
}

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Syntax-level check: https only, public-looking host, no credentials. */
export function validatePushEndpoint(raw: unknown): EndpointCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: "bad_length" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "local_host" };
  }
  if (isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host)) {
    return { ok: false, reason: "private_address" };
  }
  if (!host.includes(".") && !isIP(host.replace(/^\[|\]$/g, ""))) {
    return { ok: false, reason: "not_public_host" };
  }
  return { ok: true, url };
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const dnsLookup: Lookup = (host) => lookup(host, { all: true });

/** Full check: syntax plus every DNS answer must be public. Fails closed on DNS errors. */
export async function checkPushEndpoint(raw: unknown, resolve: Lookup = dnsLookup): Promise<EndpointCheck> {
  const syntax = validatePushEndpoint(raw);
  if (!syntax.ok) return syntax;
  const host = syntax.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return syntax;
  try {
    const answers = await resolve(host);
    if (!answers.length || answers.some((a) => isPrivateAddress(a.address))) {
      return { ok: false, reason: "resolves_private" };
    }
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  return syntax;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type PushKeys = { p256dh: string; auth: string };

/** Stores (or re-owns) a subscription for `userId`. Keys are encrypted at rest. */
export async function saveSubscription(
  userId: string,
  endpoint: string,
  keys: PushKeys,
  userAgent: string | null,
): Promise<void> {
  const values = {
    userId,
    endpoint,
    p256dhEncrypted: encryptSecret(keys.p256dh),
    authEncrypted: encryptSecret(keys.auth),
    userAgent: userAgent?.slice(0, 255) ?? null,
    lastUsedAt: new Date(),
  };
  await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
}

/** Only ever removes the caller's own subscription. */
export async function removeSubscription(userId: string, endpoint: string): Promise<number> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return rows.length;
}

export async function hasSubscription(userId: string, endpoint?: string): Promise<boolean> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      endpoint
        ? and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))
        : eq(pushSubscriptions.userId, userId),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type PushPayload = { title: string; body: string; url: string; tag?: string };

export function isPushConfigured(): boolean {
  return vapidDetails() !== null;
}

/** Only same-site paths may be a notification target. */
export function safePath(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? url.slice(0, 200) : "/home";
}

type Sender = (
  sub: { endpoint: string; keys: PushKeys },
  body: string,
) => Promise<unknown>;

function vapidDetails() {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  return subject && publicKey && privateKey ? { subject, publicKey, privateKey } : null;
}

const defaultSender: Sender = async (sub, body) => {
  const vapid = vapidDetails();
  if (!vapid) throw new Error("VAPID is not configured");
  return webpush.sendNotification(sub, body, { TTL: 60 * 60 * 24, urgency: "high", vapidDetails: vapid });
};

/** Pushes to every device of `userId`. Prunes 404/410 endpoints. Never throws. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  send: Sender = defaultSender,
): Promise<{ sent: number; pruned: number }> {
  const out = { sent: 0, pruned: 0 };
  try {
    if (send === defaultSender && !isPushConfigured()) return out;
    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    const body = JSON.stringify({ ...payload, url: safePath(payload.url) });
    for (const s of subs) {
      if (!validatePushEndpoint(s.endpoint).ok) {
        securityLog("invalid_push_endpoint", { endpoint: s.endpoint, where: "send" });
        continue;
      }
      try {
        await send(
          { endpoint: s.endpoint, keys: { p256dh: decryptSecret(s.p256dhEncrypted), auth: decryptSecret(s.authEncrypted) } },
          body,
        );
        out.sent++;
        await db.update(pushSubscriptions).set({ lastUsedAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          out.pruned++;
          securityLog("push_pruned", { endpoint: s.endpoint, status }, "info");
        } else {
          console.error(`[push] send failed: ${err instanceof Error ? err.name : "unknown"} (HTTP ${status ?? "?"})`);
        }
      }
    }
  } catch (err) {
    console.error(`[push] ${err instanceof Error ? err.name : "unknown"}`);
  }
  return out;
}
