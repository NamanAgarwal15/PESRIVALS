// Shared Gemini text client for the AI features that are not screenshot reading
// (career insights, coach chat). Walks models x keys inside a time budget.
// Keys travel in a header and are never logged or returned.

import { GEMINI_API_BASE, GEMINI_MODELS } from "@/lib/gemini-extract";
import { geminiKeyPool } from "@/lib/gemini-keys";

/** Key values from the 6-slot pool (see gemini-keys.ts). */
export function geminiKeys(): string[] {
  return geminiKeyPool().map((k) => k.value);
}

export function geminiConfigured(): boolean {
  return geminiKeys().length > 0;
}

/**
 * Sends `body` to each model/key until `accept(text)` returns a non-null value.
 * Any HTTP error, timeout, network failure or rejected output moves on to the next attempt.
 */
export async function generateGemini<T>(
  body: string,
  accept: (text: string) => T | null,
  fetcher: typeof fetch = fetch,
  budgetMs = 20_000,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (const model of GEMINI_MODELS) {
    for (const key of geminiKeys()) {
      const left = deadline - Date.now();
      if (left < 1000) return null;
      try {
        const res = await fetcher(`${GEMINI_API_BASE}/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body,
          signal: AbortSignal.timeout(Math.min(10_000, left)),
        });
        if (!res.ok) continue;
        const payload = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        const out = accept(text);
        if (out !== null) return out;
      } catch {
        // try the next key / model
      }
    }
  }
  return null;
}
