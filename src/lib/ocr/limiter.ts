// In-process cap on concurrent image decodes. A flood of screenshot uploads must not be able
// to exhaust a serverless instance's CPU or memory (OWASP A10:2025). Over the cap we do NOT
// queue (a queue is itself an unbounded resource): the caller falls back to the Gemini reader.

export const MAX_CONCURRENT_DECODES = 3;

let active = 0;
let peak = 0;

/** Takes a decode slot, or returns null when all slots are busy. Call the returned function exactly once. */
export function tryAcquireDecodeSlot(max: number = MAX_CONCURRENT_DECODES): (() => void) | null {
  if (active >= max) return null;
  active++;
  if (active > peak) peak = active;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
  };
}

export const decodeStats = () => ({ active, peak });
export const resetDecodePeak = () => {
  peak = active;
};
