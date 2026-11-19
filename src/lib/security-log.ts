// Structured JSON security events. One line per event on stdout/stderr so the
// host's log drain can alert on them. Secrets and personal data are redacted.

export type SecurityEvent =
  | "auth_blocked"
  | "rate_limited"
  | "invalid_push_endpoint"
  | "push_pruned"
  | "dispute_created"
  | "dispute_spike"
  | "request_failed";

const SENSITIVE = /^ip$|pass|secret|token|key|code|auth|cookie|email|phone|p256dh|session/i;

function redactValue(key: string, value: unknown): unknown {
  if (key === "endpoint" && typeof value === "string") {
    try {
      return `${new URL(value).host}/…`; // host only, never the subscription path
    } catch {
      return "[invalid]";
    }
  }
  if (SENSITIVE.test(key)) return "[redacted]";
  if (typeof value === "string") return value.slice(0, 200);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, redactValue(k, v)]));
}

export function securityLog(
  event: SecurityEvent,
  fields: Record<string, unknown> = {},
  level: "info" | "warn" | "error" = "warn",
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), type: "security", event, ...redact(fields) });
  (level === "error" ? console.error : level === "info" ? console.info : console.warn)(line);
}
