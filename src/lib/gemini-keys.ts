// The Gemini key pool: GEMINI_API_KEY_1 .. GEMINI_API_KEY_6. Unset or empty
// slots are skipped, so the pool works with any number of keys from 1 to 6.
// Values are read at call time, never stored, logged or returned; callers refer
// to a key only by its slot label (KEY_n).

export const GEMINI_KEY_SLOTS = 6;

export type GeminiKey = { label: string; value: string };

export function geminiKeyPool(env: Record<string, string | undefined> = process.env): GeminiKey[] {
  const pool: GeminiKey[] = [];
  for (let slot = 1; slot <= GEMINI_KEY_SLOTS; slot++) {
    const value = env[`GEMINI_API_KEY_${slot}`]?.trim() ?? "";
    if (value) pool.push({ label: `KEY_${slot}`, value });
  }
  return pool;
}
