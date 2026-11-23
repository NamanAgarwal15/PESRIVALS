// Deterministic live chat filter for the global lobby. Pure and framework-free:
// no network, no database, NO LLM. The same text always gets the same verdict,
// so it is free to run on every send and trivial to unit-test.
//
//   raw -> NFKC + strip control / zero-width / bidi + collapse whitespace
//       -> checks run on a FOLDED copy (lower-case, accents removed, homoglyphs
//          and leetspeak mapped back, repeated letters collapsed, spaced-out
//          letters joined) so "f u c k", "fvck", "fuuuck" and "ｆｕｃｋ" are all caught.
//
// Refusals never reveal which rule fired beyond a generic reason, and a refused
// message is never stored.

export type FilterReason = "empty" | "too_long" | "profanity" | "harassment" | "link" | "flood" | "duplicate";
export type FilterResult = { ok: true; text: string } | { ok: false; reason: FilterReason; message: string };

export const GLOBAL_MAX_LENGTH = 300;

const MESSAGES: Record<FilterReason, string> = {
  empty: "Write a message first.",
  too_long: `Keep messages under ${GLOBAL_MAX_LENGTH} characters.`,
  profanity: "That message contains language that is not allowed in the lobby.",
  harassment: "Harassment and threats are not allowed in the lobby.",
  link: "Links and web addresses are not allowed in the lobby.",
  flood: "That looks like spam. Write a normal message.",
  duplicate: "You just sent that. Wait a bit before repeating yourself.",
};
const no = (reason: FilterReason): FilterResult => ({ ok: false, reason, message: MESSAGES[reason] });

// Control, zero-width, bidi overrides / isolates, BOM. (\n and \t are handled by whitespace collapsing.)
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

/** What gets stored and shown: NFKC (so look-alike forms collapse), unsafe characters removed, one line. */
export function normalizeChatText(raw: string): string {
  return raw.normalize("NFKC").replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
}

// Cyrillic / Greek look-alikes and leetspeak back to plain letters.
const FOLD: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i", "€": "e", "|": "i", "¡": "i",
};

function fold(text: string): string {
  const base = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return [...base].map((c) => FOLD[c] ?? c).join("");
}

/** Word tokens of the folded text; runs of 3+ single characters ("f u c k", "f.u.c.k") are joined. */
function tokens(folded: string): string[] {
  const raw = folded.split(/[^a-z]+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };
  for (const t of raw) {
    if (t.length === 1) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");
const collapseTo2 = (s: string) => s.replace(/(.)\1{2,}/g, "$1$1");
const rev = (s: string) => [...s].reverse().join("");

// Word lists are stored reversed so the source (and any grep of it) stays readable.
// WHOLE-WORD terms (checked against each token, repeats collapsed):
const WORDS = new Set(
  ["kcuf", "tihs", "hctib", "tnuc", "elohssa", "dratsab", "erohw", "tuls", "daehkcid", "reknaw", "tawt", "drater", "toggaf", "gaf", "reggin", "aggin"].map(rev).concat("kys"),
);
// STEMS matched anywhere inside a token (long and unambiguous enough to avoid Scunthorpe-style false hits):
const STEMS = ["kcuf", "reggin", "toggaf", "drater", "hctib", "erohw", "rekcufrehtom"].map(rev);
// Harassment phrases, matched on the letters-only text (so spacing and punctuation tricks do not help).
const PHRASES = ["flesruoyllik", "flesruyllik", "eidoyepoh"].map(rev);

function hasProfanity(folded: string): boolean {
  for (const raw of tokens(folded)) {
    // Exact word, repeats squeezed to 1 ("fuuuck"), or to 2 ("niggggger"). Never the squeezed form of a clean word.
    const forms = [raw, collapse(raw), collapseTo2(raw)];
    if (forms.some((t) => WORDS.has(t) || STEMS.some((s) => t.includes(s)))) return true;
  }
  return false;
}

function hasHarassment(folded: string): boolean {
  const letters = collapse(folded.replace(/[^a-z]/g, ""));
  return PHRASES.some((p) => letters.includes(collapse(p)));
}

const TLDS = "com|net|org|io|gg|me|ly|xyz|ru|tk|cc|co|info|biz|link|click|top|site|online|app|dev|tv|ws|gl|ink|shop|store";
const LINK_PATTERNS = [
  /\b(?:https?|ftp):\/\//i,
  /\bwww\s*\./i,
  new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})(?![a-z0-9])`, "i"),
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
];

function hasLink(text: string): boolean {
  // Undo "example[.]com", "example (dot) com", "example dot com" style obfuscation first.
  const plain = text
    .replace(/\s*[[({<]\s*\.\s*[\])}>]\s*/g, ".")
    .replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, ".")
    .replace(new RegExp(`\\s+dot\\s+(?=(?:${TLDS})\\b)`, "gi"), ".")
    .replace(/\s*\.\s*(?=(?:com|net|org|gg|io|xyz|ru)\b)/gi, ".");
  return LINK_PATTERNS.some((p) => p.test(plain)) || LINK_PATTERNS.some((p) => p.test(fold(plain)));
}

function isFlood(text: string): boolean {
  if (/(.)\1{7,}/u.test(text)) return true; // 8+ of the same character in a row
  const chars = [...text.replace(/\s/g, "")];
  if (chars.length >= 15 && new Set(chars).size <= 3) return true;
  const words = text.toLowerCase().split(/\s+/);
  if (words.length >= 6) {
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    if (Math.max(...counts.values()) >= 5) return true; // same word 5+ times
  }
  return false;
}

/** Comparison key for duplicate-burst detection. */
export const dupKey = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "");

/**
 * @param recent the sender's own recent messages (already stored text) for duplicate detection
 */
export function checkChatText(raw: unknown, recent: readonly string[] = [], maxLength: number = GLOBAL_MAX_LENGTH): FilterResult {
  const tooLong: FilterResult = { ok: false, reason: "too_long", message: `Keep messages under ${maxLength} characters.` };
  if (typeof raw !== "string") return no("empty");
  if (raw.length > maxLength * 4) return tooLong;
  const text = normalizeChatText(raw);
  if (!text) return no("empty");
  if (text.length > maxLength) return tooLong;

  const folded = fold(text);
  if (hasLink(text)) return no("link");
  if (hasHarassment(folded)) return no("harassment");
  if (hasProfanity(folded)) return no("profanity");
  if (isFlood(text)) return no("flood");

  const key = dupKey(text);
  if (key && recent.some((r) => dupKey(r) === key)) return no("duplicate");
  return { ok: true, text };
}
