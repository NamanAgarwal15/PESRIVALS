// Reads an eFootball Mobile "Full Time" stats screenshot with Gemini Vision.
// Framework-free (plain fetch) so Vitest can drive it with a mocked fetch.
//
// API keys are sent in a request header and are never logged, returned or
// put in an error message. Log lines name keys as KEY_1 / KEY_2 only.

import { z } from "zod";
import { type ExtractedMatch, extractedMatchSchema } from "@/lib/match-schema";
import { SCREENSHOT_MAX_BYTES, STAT_KEYS } from "@/lib/match-stats";

export const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Tried in this order; every model is tried with every key before moving on.
// The 2.x models originally planned here now return 404 ("no longer available
// to new users"), so this list holds currently served models. If Google
// retires these too, the log line "[gemini] <model> with KEY_n failed: HTTP 404"
// shows it; refresh the list with GET /v1beta/models.
export const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
] as const;

const PER_CALL_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 50_000;

export type ScreenshotMimeType = "image/png" | "image/jpeg" | "image/webp";

export type ExtractFailureCode =
  | "invalid_image"
  | "too_large"
  | "not_stats_screen"
  | "not_configured"
  | "unavailable";

export type ExtractResult =
  | { ok: true; extracted: ExtractedMatch }
  | { ok: false; code: ExtractFailureCode; error: string };

const failure = (code: ExtractFailureCode, error: string): ExtractResult => ({
  ok: false,
  code,
  error,
});

// ---------------------------------------------------------------------------
// Image validation
// ---------------------------------------------------------------------------

// Trust the file's first bytes, not the Content-Type the browser claims.
function sniffImageType(bytes: Uint8Array): ScreenshotMimeType | null {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export type ScreenshotCheck =
  | { ok: true; mimeType: ScreenshotMimeType }
  | { ok: false; code: "invalid_image" | "too_large"; error: string };

export function validateScreenshot(bytes: Uint8Array): ScreenshotCheck {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "invalid_image", error: "Choose a screenshot to upload." };
  }
  if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
    return {
      ok: false,
      code: "too_large",
      error: "That image is larger than 8 MB. Upload a smaller screenshot.",
    };
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    return {
      ok: false,
      code: "invalid_image",
      error: "Upload a PNG, JPG or WEBP screenshot.",
    };
  }
  return { ok: true, mimeType };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const PROMPT = `You are reading a screenshot from the mobile game eFootball (formerly PES).

The only acceptable image is the post-match "Full Time" MATCH STATS screen: two teams side by side with the final score at the top, and a table of statistics with one column of numbers for the LEFT team and one for the RIGHT team.

First decide whether the image is that screen. Judge only by what is shown: a "Full Time" or match-stats layout with two team names, a final score, and a two-column table of numbers. Do not reject an image because it lacks game logos or branding, looks cropped, or seems unusual in style; reject it only when that content is genuinely missing.
- If it is NOT (a meme, a photo, a chat, a lineup, a menu, a different game, a half-time or in-progress screen, an unreadable image), set is_valid_efootball_stats_screen to false, give a short plain-English rejection_reason (under 120 characters), and set left and right to null.
- If it IS, set is_valid_efootball_stats_screen to true, rejection_reason to null, and fill in left and right.

For each side (left = the team shown on the left of the screen, right = the team shown on the right):
- team: the team name exactly as written on screen.
- goals: goals in regular play, from the main scoreline. If a penalty shoot-out score is shown separately (for example in brackets), ignore it.
- possession: the possession percentage as a whole number without the % sign.
- shots, shots_on_target, fouls, offsides, corners (corner kicks), free_kicks, passes, successful_passes, crosses, interceptions, tackles, saves: the number in that row for that side.

Rules:
- Never swap the sides. The left column belongs to the left team.
- Copy the digits you can see. Do not estimate, calculate or guess.
- If a statistic is not on the screen or cannot be read, use null for it.`;

const statSchema = { type: "INTEGER", nullable: true };
const sideSchema = {
  type: "OBJECT",
  nullable: true,
  properties: {
    team: { type: "STRING" },
    goals: { type: "INTEGER" },
    ...Object.fromEntries(STAT_KEYS.map((key) => [key, statSchema])),
  },
  required: ["team", "goals", ...STAT_KEYS],
};
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_valid_efootball_stats_screen: { type: "BOOLEAN" },
    rejection_reason: { type: "STRING", nullable: true },
    left: sideSchema,
    right: sideSchema,
  },
  required: ["is_valid_efootball_stats_screen", "rejection_reason", "left", "right"],
};

function configuredKeys(): { label: string; value: string }[] {
  return [
    { label: "KEY_1", value: process.env.GEMINI_API_KEY_1?.trim() ?? "" },
    { label: "KEY_2", value: process.env.GEMINI_API_KEY_2?.trim() ?? "" },
  ].filter((key) => key.value.length > 0);
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

const envelopeSchema = z.object({
  is_valid_efootball_stats_screen: z.boolean(),
  rejection_reason: z.string().nullish(),
  left: z.unknown().optional(),
  right: z.unknown().optional(),
});

// Safe OCR clean-ups only: "55%" -> 55, " 12 " -> 12, 7.0 -> 7, and collapsed
// whitespace in team names. Anything else is left for the schema to reject;
// numbers are never clamped, swapped or invented.
function normalizeSide(side: unknown): unknown {
  if (!side || typeof side !== "object") return side;
  const out: Record<string, unknown> = { ...(side as Record<string, unknown>) };
  if (typeof out.team === "string") out.team = out.team.replace(/\s+/g, " ").trim();
  for (const key of ["goals", ...STAT_KEYS]) {
    const value = out[key];
    if (typeof value === "string") {
      const match = /^\s*(\d{1,4})\s*%?\s*$/.exec(value);
      if (match) out[key] = Number(match[1]);
      else if (/^\s*(-|—|n\/a)?\s*$/i.test(value)) out[key] = null;
    } else if (value === undefined) {
      out[key] = null;
    }
  }
  return out;
}

type Attempt =
  | { kind: "ok"; extracted: ExtractedMatch }
  | { kind: "rejected"; reason: string | null }
  | { kind: "retry"; why: string };

function readModelText(payload: unknown): string | null {
  const parts = (payload as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
    ?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return text.trim() ? text : null;
}

function interpret(payload: unknown): Attempt {
  const text = readModelText(payload);
  if (!text) return { kind: "retry", why: "empty response" };

  let json: unknown;
  try {
    // Some models wrap JSON in a ```json fence despite the JSON mime type.
    json = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    return { kind: "retry", why: "unparseable JSON" };
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { kind: "retry", why: "unexpected JSON shape" };
  if (!envelope.data.is_valid_efootball_stats_screen) {
    return { kind: "rejected", reason: envelope.data.rejection_reason ?? null };
  }

  const match = extractedMatchSchema.safeParse({
    left: normalizeSide(envelope.data.left),
    right: normalizeSide(envelope.data.right),
  });
  if (!match.success) return { kind: "retry", why: "values failed validation" };
  return { kind: "ok", extracted: match.data };
}

async function callGemini(
  model: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      kind: "retry",
      why: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error",
    };
  }

  if (!response.ok) {
    // Google's error body names the real cause (bad key, quota, unknown model).
    // Redacted and truncated defensively so a key can never reach the logs.
    const detail = await response
      .json()
      .then((j: { error?: { status?: string; message?: string } }) =>
        [j.error?.status, j.error?.message].filter(Boolean).join(": "),
      )
      .catch(() => "");
    const safe = detail.split(apiKey).join("<key>").replace(/s+/g, " ").slice(0, 200);
    return { kind: "retry", why: `HTTP ${response.status}${safe ? ` ${safe}` : ""}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "retry", why: "unparseable response body" };
  }
  return interpret(payload);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const SERVICE_DOWN =
  "The screenshot reader is busy right now. Please try again in a minute.";

export async function extractMatchFromScreenshot(image: {
  bytes: Uint8Array;
}): Promise<ExtractResult> {
  const check = validateScreenshot(image.bytes);
  if (!check.ok) return failure(check.code, check.error);

  const keys = configuredKeys();
  if (!keys.length) {
    console.error("[gemini] no GEMINI_API_KEY_1 / GEMINI_API_KEY_2 configured");
    return failure("not_configured", "Screenshot reading is not set up yet.");
  }

  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: check.mimeType,
              data: Buffer.from(image.bytes).toString("base64"),
            },
          },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const model of GEMINI_MODELS) {
    for (const key of keys) {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) {
        console.warn("[gemini] time budget used up");
        return failure("unavailable", SERVICE_DOWN);
      }

      const attempt = await callGemini(
        model,
        key.value,
        body,
        Math.min(PER_CALL_TIMEOUT_MS, remaining),
      );

      if (attempt.kind === "ok") return { ok: true, extracted: attempt.extracted };

      if (attempt.kind === "rejected") {
        const reason = attempt.reason?.replace(/\s+/g, " ").trim().slice(0, 160);
        return failure(
          "not_stats_screen",
          `That does not look like an eFootball Full Time stats screen${
            reason ? ` (${reason.replace(/[.!]+$/, "")})` : ""
          }. Upload the match stats screenshot.`,
        );
      }

      // Rate limit, server error, timeout, bad JSON, rejected key, unknown
      // model: move on to the next key / model.
      console.warn(`[gemini] ${model} with ${key.label} failed: ${attempt.why}`);
    }
  }

  return failure("unavailable", SERVICE_DOWN);
}
