// Single place that talks to Resend. Resend v6 does NOT throw on API errors:
// it resolves with { data: null, error }, so the error must be inspected.
// Env values are trimmed (pasted keys often carry a trailing newline) and the
// exact error name/message is logged server-side. Secrets are never logged.
// Framework-free so it can be unit-tested.

export const DEFAULT_FROM = "PESRIVALS <onboarding@resend.dev>";

export function resendConfig(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, from: process.env.RESET_EMAIL_FROM?.trim() || DEFAULT_FROM };
}

/** Returns true only when Resend accepted the message. Never throws. */
export async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const config = resendConfig();
  if (!config) {
    console.error("[email] RESEND_API_KEY is not configured");
    return false;
  }
  try {
    const { Resend } = await import("resend");
    const { error } = await new Resend(config.apiKey).emails.send({
      from: config.from,
      ...message,
    });
    if (error) {
      console.error(
        `[email] Resend rejected the send: ${error.name} (HTTP ${error.statusCode ?? "?"}): ${error.message}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[email] Resend call failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown error"}`,
    );
    return false;
  }
}
