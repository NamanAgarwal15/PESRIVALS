// Tests for the screenshot -> match flow.
//  - The Gemini extractor is driven with a mocked fetch: no real API call is
//    ever made and no quota is used.
//  - Saving and listing matches run against the LOCAL TEST database; every
//    row created here is tracked and deleted again in afterAll.

import { randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import {
  GEMINI_API_BASE,
  GEMINI_MODELS,
  extractMatchFromScreenshot,
  validateScreenshot,
} from "@/lib/gemini-extract";
import {
  extractForMember,
  getRivalryMatches,
  saveMatchForUser,
} from "@/lib/match-helpers";
import type { ExtractedMatch, ExtractedSide } from "@/lib/match-schema";
import { STAT_KEYS, matchOutcome } from "@/lib/match-stats";
import { canonicalPair, getUserRivalries } from "@/lib/rivalry-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_1 = "test-key-one-not-real";
const KEY_2 = "test-key-two-not-real";

// Every number differs between the two sides, so a swapped column is caught.
const LEFT: ExtractedSide = {
  team: "FC Left",
  goals: 2,
  possession: 55,
  shots: 12,
  shots_on_target: 6,
  fouls: 3,
  offsides: 1,
  corners: 4,
  free_kicks: 5,
  passes: 210,
  successful_passes: 180,
  crosses: 7,
  interceptions: 9,
  tackles: 11,
  saves: 0,
};
const RIGHT: ExtractedSide = {
  team: "Right United",
  goals: 1,
  possession: 45,
  shots: 8,
  shots_on_target: 2,
  fouls: 6,
  offsides: 10,
  corners: 13,
  free_kicks: 14,
  passes: 150,
  successful_passes: 120,
  crosses: 15,
  interceptions: 16,
  tackles: 17,
  saves: 18,
};
const EXTRACTED: ExtractedMatch = { left: LEFT, right: RIGHT };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0))));

// ---------------------------------------------------------------------------
// Gemini fetch mock. Requests to anything else (the database) pass through.
// ---------------------------------------------------------------------------

type GeminiCall = { model: string; key: string | null; body: Record<string, unknown> };
type Reply = Response | Error | (() => Response | Error);

const realFetch = globalThis.fetch;
let calls: GeminiCall[] = [];
let replies: Reply[] = [];
let logged: string[] = [];

const modelReply = (payload: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const validReply = (overrides: Partial<{ left: unknown; right: unknown }> = {}) =>
  modelReply({
    is_valid_efootball_stats_screen: true,
    rejection_reason: null,
    left: LEFT,
    right: RIGHT,
    ...overrides,
  });
const httpError = (status: number) =>
  new Response(JSON.stringify({ error: { code: status, message: "upstream says no" } }), { status });

beforeEach(() => {
  calls = [];
  replies = [];
  logged = [];
  process.env.GEMINI_API_KEY_1 = KEY_1;
  process.env.GEMINI_API_KEY_2 = KEY_2;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GEMINI_API_BASE)) return realFetch(input, init);

    calls.push({
      model: url.slice(GEMINI_API_BASE.length + 1).split(":")[0],
      key: new Headers(init?.headers).get("x-goog-api-key"),
      body: JSON.parse(String(init?.body)),
    });
    const next = replies.shift();
    if (!next) throw new Error("Unexpected Gemini call: no mocked reply left");
    const reply = typeof next === "function" ? next() : next;
    if (reply instanceof Error) throw reply;
    return reply;
  });

  for (const level of ["warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  // Nothing that was logged may contain an API key.
  for (const line of logged) {
    expect(line).not.toContain(KEY_1);
    expect(line).not.toContain(KEY_2);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------

const RUN = `m${randomBytes(3).toString("hex")}`;
const createdUserIds = new Set<string>();
let counter = 0;

async function makeUser(label: string) {
  const [row] = await db
    .insert(users)
    .values({
      username: `${RUN}_${label}${counter++}`.slice(0, 20),
      displayName: `Test ${label}`,
      updatedAt: new Date(),
    })
    .returning();
  createdUserIds.add(row.id);
  return row;
}

/** Two users and a rivalry between them. `a` is always the canonical user_a. */
async function makeRivalry(status: "active" | "pending" = "active") {
  const [p, q] = await Promise.all([makeUser("p"), makeUser("p")]);
  const [userAId, userBId] = canonicalPair(p.id, q.id);
  const a = p.id === userAId ? p : q;
  const b = p.id === userAId ? q : p;
  const [rivalry] = await db
    .insert(rivalries)
    .values({
      userAId,
      userBId,
      status,
      requestedBy: userAId,
      acceptedAt: status === "active" ? new Date() : null,
    })
    .returning();
  return { id: rivalry.id, a, b };
}

const input = (rivalryId: string, overrides: Record<string, unknown> = {}) => ({
  rivalryId,
  extracted: EXTRACTED,
  mySide: "left",
  host: "home",
  decidedOnPens: false,
  remark: "",
  ...overrides,
});

async function mustSave(userId: string, payload: Record<string, unknown>) {
  const result = await saveMatchForUser(userId, payload);
  if (!result.ok) throw new Error(`save failed: ${result.error}`);
  return result;
}

const matchRow = async (id: string) =>
  (await db.select().from(matches).where(eq(matches.id, id)))[0];
const matchesOf = (rivalryId: string) =>
  db.select().from(matches).where(eq(matches.rivalryId, rivalryId));

afterAll(async () => {
  const ids = [...createdUserIds];
  if (ids.length) {
    // Matches go with their rivalry (ON DELETE CASCADE).
    await db
      .delete(rivalries)
      .where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

// ---------------------------------------------------------------------------
// Outcome rule
// ---------------------------------------------------------------------------

describe("matchOutcome", () => {
  it("is win, loss or draw by score", () => {
    expect(matchOutcome(2, 1, false)).toBe("win");
    expect(matchOutcome(0, 3, false)).toBe("loss");
    expect(matchOutcome(1, 1, false)).toBe("draw");
  });

  it("is ALWAYS a draw when decided on penalties, whatever the score", () => {
    expect(matchOutcome(2, 1, true)).toBe("draw");
    expect(matchOutcome(0, 3, true)).toBe("draw");
    expect(matchOutcome(1, 1, true)).toBe("draw");
  });
});

// ---------------------------------------------------------------------------
// Gemini extractor (mocked fetch)
// ---------------------------------------------------------------------------

describe("screenshot validation", () => {
  it("accepts PNG, JPEG and WEBP by their first bytes", () => {
    expect(validateScreenshot(PNG)).toEqual({ ok: true, mimeType: "image/png" });
    expect(validateScreenshot(JPEG)).toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(validateScreenshot(WEBP)).toEqual({ ok: true, mimeType: "image/webp" });
  });

  it("rejects non-images, empty files and files over 8 MB without calling Gemini", async () => {
    const text = new TextEncoder().encode("GIF89a this is definitely not a screenshot");
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    huge.set(PNG);

    expect(await extractMatchFromScreenshot({ bytes: text })).toMatchObject({
      ok: false,
      code: "invalid_image",
    });
    expect(await extractMatchFromScreenshot({ bytes: new Uint8Array() })).toMatchObject({
      ok: false,
      code: "invalid_image",
    });
    expect(await extractMatchFromScreenshot({ bytes: huge })).toMatchObject({
      ok: false,
      code: "too_large",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("extractMatchFromScreenshot", () => {
  it("parses a valid response and sends a structured-JSON request with the first model and key", async () => {
    replies = [validReply()];

    const result = await extractMatchFromScreenshot({ bytes: JPEG });

    expect(result).toMatchObject({ ok: true, extracted: EXTRACTED });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(GEMINI_MODELS[0]);
    expect(calls[0].key).toBe(KEY_1);

    const body = calls[0].body as {
      contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
      generationConfig: { responseMimeType: string; responseSchema: unknown };
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeTruthy();
    const image = body.contents[0].parts.find((p) => p.inlineData)!.inlineData!;
    expect(image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(JPEG));
    // The key travels in a header, never in the URL or the body.
    expect(JSON.stringify(body)).not.toContain(KEY_1);
  });

  it("keeps unreadable stats as null and tidies safe OCR slips", async () => {
    replies = [
      validReply({
        left: { ...LEFT, team: "  FC   Left ", possession: "55%", shots: " 12 ", saves: null },
        right: { ...RIGHT, crosses: null, tackles: "-" },
      }),
    ];

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extracted.left).toEqual({ ...LEFT, saves: null });
    expect(result.extracted.right).toEqual({ ...RIGHT, crosses: null, tackles: null });
  });

  it("rejects an image that is not an eFootball stats screen, without trying other models", async () => {
    replies = [
      modelReply({
        is_valid_efootball_stats_screen: false,
        rejection_reason: "This is a photo of a cat.",
        left: null,
        right: null,
      }),
    ];

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result).toMatchObject({ ok: false, code: "not_stats_screen" });
    if (result.ok) return;
    expect(result.error).toContain("eFootball Full Time stats screen");
    expect(result.error).toContain("photo of a cat");
    expect(calls).toHaveLength(1);
  });

  it("falls back from KEY_1 (429 rate limit) to KEY_2 on the same model", async () => {
    replies = [httpError(429), validReply()];

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result).toMatchObject({ ok: true, extracted: EXTRACTED });
    expect(calls.map((c) => [c.model, c.key])).toEqual([
      [GEMINI_MODELS[0], KEY_1],
      [GEMINI_MODELS[0], KEY_2],
    ]);
  });

  it("falls back to the next model when both keys fail on the first", async () => {
    replies = [httpError(503), httpError(500), validReply()];

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => [c.model, c.key])).toEqual([
      [GEMINI_MODELS[0], KEY_1],
      [GEMINI_MODELS[0], KEY_2],
      [GEMINI_MODELS[1], KEY_1],
    ]);
  });

  it("treats timeouts, network errors, bad JSON and impossible numbers as retryable", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    replies = [
      timeout,
      new TypeError("fetch failed"),
      modelReply("{ this is not json"),
      validReply({ left: { ...LEFT, shots_on_target: 99 } }), // more on target than shots
      new Response("<html>bad gateway</html>", { status: 502 }),
      validReply(),
    ];

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result).toMatchObject({ ok: true, extracted: EXTRACTED });
    expect(calls).toHaveLength(6);
    expect(calls[5]).toMatchObject({ model: GEMINI_MODELS[2], key: KEY_2 });
  });

  it("fails cleanly when every key and model fails, without leaking a key", async () => {
    replies = [429, 429, 503, 500, 504, 502].map(httpError);

    const result = await extractMatchFromScreenshot({ bytes: PNG });

    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(calls.map((c) => [c.model, c.key])).toEqual(
      GEMINI_MODELS.flatMap((model) => [
        [model, KEY_1],
        [model, KEY_2],
      ]),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY_1);
    expect(text).not.toContain(KEY_2);
    expect(text).not.toContain("upstream says no");
    expect(logged.length).toBe(6);
  });

  it("uses only the keys that are configured", async () => {
    process.env.GEMINI_API_KEY_1 = "   ";
    replies = [httpError(429), httpError(429), httpError(429)];

    expect(await extractMatchFromScreenshot({ bytes: PNG })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(calls.map((c) => c.key)).toEqual([KEY_2, KEY_2, KEY_2]);
  });

  it("reports not_configured when there is no key at all", async () => {
    delete process.env.GEMINI_API_KEY_1;
    process.env.GEMINI_API_KEY_2 = "";

    expect(await extractMatchFromScreenshot({ bytes: PNG })).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Saving (LOCAL TEST database)
// ---------------------------------------------------------------------------

// [stat, user_a column, user_b column] written out by hand, independently of
// the mapping in match-helpers.ts.
const STAT_COLUMNS = [
  ["possession", "userAPossession", "userBPossession"],
  ["shots", "userAShots", "userBShots"],
  ["shots_on_target", "userAShotsOnTarget", "userBShotsOnTarget"],
  ["fouls", "userAFouls", "userBFouls"],
  ["offsides", "userAOffsides", "userBOffsides"],
  ["corners", "userACorners", "userBCorners"],
  ["free_kicks", "userAFreeKicks", "userBFreeKicks"],
  ["passes", "userAPasses", "userBPasses"],
  ["successful_passes", "userASuccessfulPasses", "userBSuccessfulPasses"],
  ["crosses", "userACrosses", "userBCrosses"],
  ["interceptions", "userAInterceptions", "userBInterceptions"],
  ["tackles", "userATackles", "userBTackles"],
  ["saves", "userASaves", "userBSaves"],
] as const;

describe("saveMatchForUser: left/right -> user_a/user_b mapping", () => {
  it("the test's column table covers all 13 stats", () => {
    expect(STAT_COLUMNS.map(([stat]) => stat)).toEqual([...STAT_KEYS]);
  });

  const cases = [
    { actor: "a", mySide: "left", slotA: LEFT, slotB: RIGHT },
    { actor: "a", mySide: "right", slotA: RIGHT, slotB: LEFT },
    { actor: "b", mySide: "left", slotA: RIGHT, slotB: LEFT },
    { actor: "b", mySide: "right", slotA: LEFT, slotB: RIGHT },
  ] as const;

  for (const { actor, mySide, slotA, slotB } of cases) {
    it(`current user is user_${actor} and played ${mySide}`, async () => {
      const rivalry = await makeRivalry();
      const me = rivalry[actor];

      const saved = await mustSave(me.id, input(rivalry.id, { mySide }));
      const row = (await matchRow(saved.matchId)) as unknown as Record<string, unknown>;

      expect(row.userATeam).toBe(slotA.team);
      expect(row.userBTeam).toBe(slotB.team);
      expect(row.userAGoals).toBe(slotA.goals);
      expect(row.userBGoals).toBe(slotB.goals);
      for (const [stat, aColumn, bColumn] of STAT_COLUMNS) {
        expect(row[aColumn], `${aColumn}`).toBe(slotA[stat]);
        expect(row[bColumn], `${bColumn}`).toBe(slotB[stat]);
      }

      // And read back per player: each one sees their own side as "mine".
      const mine = extractedFor(mySide);
      const [forMe] = await getRivalryMatches(me.id, rivalry.id);
      expect(forMe).toMatchObject({
        myTeam: mine.me.team,
        myGoals: mine.me.goals,
        opponentTeam: mine.opponent.team,
        opponentGoals: mine.opponent.goals,
      });
      const other = actor === "a" ? rivalry.b : rivalry.a;
      const [forThem] = await getRivalryMatches(other.id, rivalry.id);
      expect(forThem).toMatchObject({
        myTeam: mine.opponent.team,
        myGoals: mine.opponent.goals,
        opponentTeam: mine.me.team,
        opponentGoals: mine.me.goals,
      });
    });
  }

  function extractedFor(mySide: "left" | "right") {
    return mySide === "left" ? { me: LEFT, opponent: RIGHT } : { me: RIGHT, opponent: LEFT };
  }
});

describe("saveMatchForUser", () => {
  it("stores the fixed fields for a screenshot match", async () => {
    const rivalry = await makeRivalry();
    const saved = await mustSave(rivalry.b.id, input(rivalry.id, { remark: "  What a game  " }));
    const row = await matchRow(saved.matchId);

    expect(saved.matchNo).toBe(1);
    expect(row).toMatchObject({
      rivalryId: rivalry.id,
      matchNo: 1,
      source: "screenshot",
      status: "confirmed",
      needsReview: false,
      createdBy: rivalry.b.id,
      decidedOnPens: false,
      remark: "What a game",
      playedAt: new Date().toISOString().slice(0, 10),
      sourceSheetRow: null,
    });
  });

  it("maps home to the current user and away to the opponent, for either player", async () => {
    const rivalry = await makeRivalry();

    const homeByA = await mustSave(rivalry.a.id, input(rivalry.id, { host: "home" }));
    const awayByA = await mustSave(rivalry.a.id, input(rivalry.id, { host: "away" }));
    const homeByB = await mustSave(rivalry.b.id, input(rivalry.id, { host: "home" }));
    const awayByB = await mustSave(rivalry.b.id, input(rivalry.id, { host: "away" }));

    expect((await matchRow(homeByA.matchId)).hostUserId).toBe(rivalry.a.id);
    expect((await matchRow(awayByA.matchId)).hostUserId).toBe(rivalry.b.id);
    expect((await matchRow(homeByB.matchId)).hostUserId).toBe(rivalry.b.id);
    expect((await matchRow(awayByB.matchId)).hostUserId).toBe(rivalry.a.id);

    // Newest first; "home" means the viewer hosted.
    expect((await getRivalryMatches(rivalry.a.id, rivalry.id)).map((m) => m.venue)).toEqual([
      "home", // awayByB: a hosted
      "away", // homeByB
      "away", // awayByA
      "home", // homeByA
    ]);
    expect((await getRivalryMatches(rivalry.b.id, rivalry.id)).map((m) => m.venue)).toEqual([
      "away",
      "home",
      "home",
      "away",
    ]);
  });

  it("requires an explicit side and host: no default, no neutral option", async () => {
    const rivalry = await makeRivalry();

    for (const overrides of [
      { mySide: undefined },
      { mySide: "" },
      { mySide: "middle" },
      { host: undefined },
      { host: "neutral" },
      { host: null },
    ]) {
      const result = await saveMatchForUser(rivalry.a.id, input(rivalry.id, overrides));
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
    }
    expect(await matchesOf(rivalry.id)).toHaveLength(0);
  });

  it("saves decided_on_pens and counts the match as a draw for both players", async () => {
    const rivalry = await makeRivalry();
    // Left won 2-1 on the scoreline, but it went to penalties.
    const saved = await mustSave(rivalry.a.id, input(rivalry.id, { decidedOnPens: true }));

    expect((await matchRow(saved.matchId)).decidedOnPens).toBe(true);
    const [forA] = await getRivalryMatches(rivalry.a.id, rivalry.id);
    const [forB] = await getRivalryMatches(rivalry.b.id, rivalry.id);
    expect(forA).toMatchObject({ myGoals: 2, opponentGoals: 1, decidedOnPens: true, outcome: "draw" });
    expect(forB).toMatchObject({ myGoals: 1, opponentGoals: 2, decidedOnPens: true, outcome: "draw" });
  });

  it("without penalties the same score is a win for one and a loss for the other", async () => {
    const rivalry = await makeRivalry();
    await mustSave(rivalry.a.id, input(rivalry.id));

    expect((await getRivalryMatches(rivalry.a.id, rivalry.id))[0].outcome).toBe("win");
    expect((await getRivalryMatches(rivalry.b.id, rivalry.id))[0].outcome).toBe("loss");
  });

  it("defaults decided_on_pens to false and stores a blank remark as null", async () => {
    const rivalry = await makeRivalry();
    const payload = input(rivalry.id, { remark: "   " }) as Record<string, unknown>;
    delete payload.decidedOnPens;

    const row = await matchRow((await mustSave(rivalry.a.id, payload)).matchId);
    expect(row.decidedOnPens).toBe(false);
    expect(row.remark).toBeNull();

    const tooLong = await saveMatchForUser(rivalry.a.id, input(rivalry.id, { remark: "x".repeat(201) }));
    expect(tooLong.ok).toBe(false);
    const justRight = await mustSave(rivalry.a.id, input(rivalry.id, { remark: "x".repeat(200) }));
    expect((await matchRow(justRight.matchId)).remark).toHaveLength(200);
  });

  it("numbers matches 1, 2, 3 within a rivalry, independently of other rivalries", async () => {
    const [first, second] = await Promise.all([makeRivalry(), makeRivalry()]);

    expect((await mustSave(first.a.id, input(first.id))).matchNo).toBe(1);
    expect((await mustSave(first.b.id, input(first.id))).matchNo).toBe(2);
    expect((await mustSave(second.a.id, input(second.id))).matchNo).toBe(1);
    expect((await mustSave(first.a.id, input(first.id))).matchNo).toBe(3);

    expect((await getRivalryMatches(first.a.id, first.id)).map((m) => m.matchNo)).toEqual([3, 2, 1]);
  });

  it("gives distinct numbers when both players save at the same moment", async () => {
    const rivalry = await makeRivalry();
    await mustSave(rivalry.a.id, input(rivalry.id));

    const results = await Promise.all([
      saveMatchForUser(rivalry.a.id, input(rivalry.id)),
      saveMatchForUser(rivalry.b.id, input(rivalry.id, { mySide: "right" })),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.matchNo : 0)).sort()).toEqual([2, 3]);
    expect(await matchesOf(rivalry.id)).toHaveLength(3);
  });

  it("re-validates the payload: tampered stats are rejected and nothing is saved", async () => {
    const rivalry = await makeRivalry();
    const tampered: [string, ExtractedMatch | Record<string, unknown>][] = [
      ["shots on target > shots", { left: { ...LEFT, shots_on_target: 13 }, right: RIGHT }],
      ["successful passes > passes", { left: LEFT, right: { ...RIGHT, successful_passes: 151 } }],
      ["possession > 100", { left: { ...LEFT, possession: 101 }, right: RIGHT }],
      ["negative possession", { left: LEFT, right: { ...RIGHT, possession: -1 } }],
      ["goals > 99", { left: { ...LEFT, goals: 100 }, right: RIGHT }],
      ["negative goals", { left: LEFT, right: { ...RIGHT, goals: -1 } }],
      ["negative stat", { left: { ...LEFT, fouls: -2 }, right: RIGHT }],
      ["fractional stat", { left: { ...LEFT, shots: 1.5 }, right: RIGHT }],
      ["string stat", { left: { ...LEFT, shots: "12" }, right: RIGHT }],
      ["empty team", { left: { ...LEFT, team: "   " }, right: RIGHT }],
      ["team too long", { left: LEFT, right: { ...RIGHT, team: "x".repeat(61) } }],
      ["missing side", { left: LEFT }],
      ["not an object", { left: "FC Left", right: "Right United" }],
    ];

    for (const [label, extracted] of tampered) {
      const result = await saveMatchForUser(rivalry.a.id, input(rivalry.id, { extracted }));
      expect(result.ok, label).toBe(false);
    }
    expect(await matchesOf(rivalry.id)).toHaveLength(0);
  });

  it("the database CHECK constraints reject the same bad numbers", async () => {
    const rivalry = await makeRivalry();
    const insert = (extra: Record<string, number>) =>
      db.insert(matches).values({
        rivalryId: rivalry.id,
        matchNo: 99,
        source: "screenshot",
        userATeam: "A",
        userBTeam: "B",
        userAGoals: 1,
        userBGoals: 1,
        ...extra,
      });

    await expect(insert({ userAShots: 5, userAShotsOnTarget: 6 })).rejects.toThrow();
    await expect(insert({ userBPasses: 10, userBSuccessfulPasses: 11 })).rejects.toThrow();
    await expect(insert({ userAPossession: 101 })).rejects.toThrow();
    await expect(insert({ userBGoals: 100 })).rejects.toThrow();
    expect(await matchesOf(rivalry.id)).toHaveLength(0);
  });

  it("blocks a non-member from saving or extracting", async () => {
    const rivalry = await makeRivalry();
    const outsider = await makeUser("out");

    expect(await saveMatchForUser(outsider.id, input(rivalry.id))).toEqual({
      ok: false,
      error: "Rivalry not found",
    });
    expect(await extractForMember(outsider.id, rivalry.id, { bytes: PNG })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await getRivalryMatches(outsider.id, rivalry.id)).toEqual([]);

    for (const badId of ["not-a-uuid", "11111111-1111-4111-8111-111111111111", undefined]) {
      expect((await saveMatchForUser(rivalry.a.id, input(rivalry.id, { rivalryId: badId }))).ok).toBe(false);
      expect((await extractForMember(rivalry.a.id, badId, { bytes: PNG })).ok).toBe(false);
    }

    expect(calls).toHaveLength(0); // Gemini was never contacted
    expect(await matchesOf(rivalry.id)).toHaveLength(0);
  });

  it("blocks members of a rivalry that is not active yet", async () => {
    const rivalry = await makeRivalry("pending");

    expect((await saveMatchForUser(rivalry.a.id, input(rivalry.id))).ok).toBe(false);
    expect((await extractForMember(rivalry.b.id, rivalry.id, { bytes: PNG })).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await matchesOf(rivalry.id)).toHaveLength(0);
  });

  it("lets a member extract, and the result can be saved as-is", async () => {
    const rivalry = await makeRivalry();
    replies = [validReply()];

    const result = await extractForMember(rivalry.b.id, rivalry.id, { bytes: PNG });
    expect(result).toMatchObject({ ok: true, extracted: EXTRACTED });
    if (!result.ok) return;

    const saved = await mustSave(
      rivalry.b.id,
      input(rivalry.id, { extracted: result.extracted, mySide: "right", host: "away" }),
    );
    expect(await matchRow(saved.matchId)).toMatchObject({
      userBTeam: RIGHT.team,
      userATeam: LEFT.team,
      hostUserId: rivalry.a.id,
    });
  });

  it("the /home match count follows saved matches", async () => {
    const rivalry = await makeRivalry();
    const count = async () =>
      (await getUserRivalries(rivalry.a.id)).activeRivalries.find((r) => r.id === rivalry.id)!
        .matchCount;

    expect(await count()).toBe(0);
    await mustSave(rivalry.a.id, input(rivalry.id));
    expect(await count()).toBe(1);
    await mustSave(rivalry.b.id, input(rivalry.id));
    expect(await count()).toBe(2);
  });
});
