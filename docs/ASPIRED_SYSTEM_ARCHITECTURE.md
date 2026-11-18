# PESRIVALS — System Architecture & Roadmap

> Reconciled against the codebase at commit `a0c9ae6`. Every item carries one status tag:
>
> - **`Shipped (Today)`** — in production code and verified.
> - **`Next Polish (Immediate)`** — decided, small-to-medium, next to build.
> - **`Roadmap (Future)`** — designed, sequenced after the polish work.

## 1. Executive vision & ingestion

PESRIVALS turns casual eFootball 1v1 rivalries into a trustworthy, shareable competitive record: log a match in seconds, see what actually drives wins, and (later) get honest odds before kickoff.

| Pillar | Answer | Status |
|---|---|---|
| Effortless logging | Screenshot of the Full Time screen, read by Gemini Vision | `Shipped (Today)` |
| Trustworthy stats | Confirmed-only aggregation; AI confidence flags and opponent dispute | `Next Polish (Immediate)` |
| Rivalry depth | Per-rivalry Bento dashboard and career stats | `Shipped (Today)` |
| Community | Global leaderboard with rivalry requests | `Shipped (Today)` |
| Safety & privacy | Hashed secrets, RBAC, rate limits; peer privacy model and suspension gaps | `Shipped (Today)` / `Next Polish (Immediate)` |

### 1.0 Ingestion as it exists

Screenshot ingestion is the primary live path. Historical data was loaded by one-off Excel scripts; there is no manual-entry path and none is planned.

| Path | Code | `matches.source` | Status |
|---|---|---|---|
| Screenshot extraction | `src/lib/gemini-extract.ts` (`extractMatchFromScreenshot`), orchestrated by `src/lib/match-helpers.ts` (`extractForMember`, save), exposed at `src/app/api/rivalry/[id]/extract/route.ts` | `screenshot` | `Shipped (Today)` |
| Historical Excel import | `scripts/seed-sheet.mjs`, `scripts/import-live-history.mjs`, `scripts/sheet-parser.mjs` | `import` | `Shipped (Today)` (one-off) |

Schema facts (`src/db/schema.ts`): `match_source` = `import | screenshot`; `match_status` = `confirmed | pending | disputed` (only `confirmed` is written today); `matches.needs_review` exists but is always saved as `false`. Stats are 13 nullable per-side columns (possession, shots, shots on target, fouls, offsides, corners, free kicks, passes, successful passes, crosses, interceptions, tackles, saves).

### 1.1 `MatchTelemetryIngestor` adapter layer — `Next Polish (Immediate)`

Today the screenshot reader and the Excel scripts are unrelated code. The refactor puts them behind one interface so the rest of the app only deals with a canonical match:

```ts
interface MatchTelemetryIngestor {
  readonly source: "screenshot" | "import" | "konami_s2s";
  ingest(input: IngestInput): Promise<CanonicalMatch>; // validated by match-schema.ts
}
```

| Adapter | Source | Status |
|---|---|---|
| `VisionVlmIngestor` (wraps `gemini-extract.ts`) | `screenshot` | `Next Polish (Immediate)` |
| `SheetImportIngestor` (wraps the sheet scripts) | `import` | `Next Polish (Immediate)` |
| `KonamiIdIngestor` (signed S2S webhooks, idempotent by upstream match id) | `konami_s2s` | `Roadmap (Future)` — only if Konami ever opens an external API |

### 1.2 Two-layer trust flow — `Next Polish (Immediate)`

1. **AI confidence flags (before saving).** Each extracted field is shown **green** (confident) or **yellow** (needs a look). Yellow is raised for low model confidence or blurry OCR, and for internal inconsistencies such as `shotsOnTarget > shots`, `successfulPasses > passes`, possession not summing to ~100, or a score that disagrees with other fields. The uploader fixes yellow fields before confirming.
2. **Instant save plus opponent dispute (after saving).** The match is saved as `confirmed` immediately so logging stays fast. The opponent sees a **Dispute** button; using it moves the match to `disputed` (a status that already exists in the enum) for peer or admin resolution. Disputed matches are excluded from analytics and the leaderboard until resolved, and `needs_review` is set when any field was yellow.

### 1.3 Optional eFootball Player ID — `Next Polish (Immediate)`

An optional `efootball_id` profile field (9 digits, unique when set) that users can display and copy so rivals can add each other in-game. It is display-only today. If a KONAMI S2S API ever exists, the same field becomes the identity binding key; unbound IDs are never auto-merged.

## 2. Screenshot ingestion capabilities

| Capability | Status |
|---|---|
| Single Full Time stats screen extraction | `Shipped (Today)` |
| Client-side image compression (max 1600px, JPEG 0.85) so uploads stay under Vercel's 4.5 MB body limit (`src/components/matches/upload-match-panel.tsx`) | `Shipped (Today)` |
| Gemini fallback chain: 3 models × 2 API keys inside a 50 s budget; upstream failure reasons logged server-side | `Shipped (Today)` |
| Magic-byte PNG/JPEG/WebP validation (`src/lib/image-bytes.ts`) | `Shipped (Today)` |
| Per-field confidence and review flow | `Next Polish (Immediate)` (see §1.2) |
| Multi-screen batch upload: Stats + Player Ratings + Match Events | `Roadmap (Future)` |
| Video keyframe sampling (scene-change frames, perceptual-hash dedupe) | `Roadmap (Future)` |
| 1-tap tactical playstyle tags: *Possession Game, Quick Counter, Long Ball Counter, Out Wide, Long Ball* | `Roadmap (Future)` |

## 3. Three-tier data-science pipeline

All tiers use confirmed matches only.

### Tier 1A — Core descriptive rivalry & career stats — `Shipped (Today)`

Implemented in `src/lib/rivalry-analytics.ts` and `src/lib/career-stats.ts`, rendered by `src/components/dashboard/rivalry-dashboard.tsx` and the `/stats` page:

- W-D-L summary, goals for/against, goal difference, clean sheets, current and longest streaks.
- Hosting split (`computeHosting`).
- `last5` / `last10` / `last20` windows and a trend series.
- Per-stat averages and head-to-head comparison, with three derived rates: **shot accuracy**, **goal conversion** and **pass accuracy**.
- Records (biggest wins and similar) and host/outcome/margin filters.
- Career stats across all rivalries (`getCareerStats`) and the aggregated global leaderboard (`src/lib/leaderboard.ts`).

### Tier 1B — Exploratory Rivalry Lab & derived football indices — `Next Polish (Immediate)`

**The five derived indices**

| Index | Definition |
|---|---|
| Shot Clinical Index | goals / shots on target, shrunk toward the global mean for small samples |
| Build-Up Tempo | passes per minute of possession |
| Progressive Directness | crosses / passes |
| Pressing Intensity (PPDA proxy) | `opponentPasses / (tackles + interceptions + fouls)` |
| Goalkeeping Save Efficiency | `saves / opponentShotsOnTarget` |

**Exploratory rivalry EDA widgets**

1. **Clutch & Blowout Profile** — record and win % in one-goal games versus 4+ goal blowouts, and average winning margin.
2. **"When leading in stat X → win %"** — conditional win rates by stat.
3. **Stat-to-goal-difference Pearson correlation (`r`)** — which metrics actually drive wins in this rivalry.
4. **Session / matchday breakdown** — games played on the same date grouped together.
5. **Most common scorelines and win-margin distribution.**

### Tier 2 — Causal inference engine — `Roadmap (Future)`

Propensity Score Matching / IPTW with opponent rating, host seat and playstyle tag as covariates, plus bootstrap confidence intervals and overlap diagnostics. **Gated:** it unlocks only at **N ≥ 30 tagged matches** per rivalry. Until then the UI shows a readiness indicator (for example "12 / 30 tagged matches"). Results are shown as an estimate with uncertainty, never a bare number. Depends on tactical tags (§2).

### Tier 3 — Predictive & sequential engine — `Roadmap (Future)`

| Stage | Unlocks at | Components |
|---|---|---|
| 3A | N ≥ 5 matches | Global and H2H EWMA form; host-seat bias adjustment; **Bivariate Poisson** pre-match W-D-L probabilities and exact-score grid |
| 3B | N ≥ 20 matches | Glicko-2 / hierarchical Bayesian rating with H2H shrinkage; session tilt/fatigue detector; playstyle clash matrix |

Every model is versioned, backtested on a time-ordered holdout, shown with calibration (reliability plot, Brier score), and never used for moderation or leaderboard ranking.

## 4. Security, privacy & auth

### 4.1 Verified matrix

| Area | Control | Code | Status |
|---|---|---|---|
| Passwords | bcrypt cost 12, strength policy | `src/lib/auth-helpers.ts` | `Shipped (Today)` |
| Login throttle | failure counting with lockout | `src/lib/auth-helpers.ts` (`login_throttle`) | `Shipped (Today)` |
| Reset tokens | 32-byte random, SHA-256 stored, 15 min, single use | `src/lib/password-reset.ts`, `src/lib/auth-actions.ts` | `Shipped (Today)` |
| Login OTP | 6 digits, SHA-256 stored, 10 min, max 3 attempts, 3 sends / 15 min | `src/lib/otp.ts` | `Shipped (Today)` |
| Email delivery | **Resend is the sole provider** for OTPs and password resets; env values trimmed, `{ error }` inspected and logged without secrets; the default sender only reaches the Resend account owner until a domain is verified | `src/lib/email.ts` | `Shipped (Today)` |
| Profile changes | email/password changes confirmed by an emailed code | `src/lib/profile.ts` | `Shipped (Today)` |
| Google sign-in | OAuth with account linking | Auth.js Google provider | `Shipped (Today)` |
| Enumeration | generic login/forgot/OTP responses | `src/lib/auth-actions.ts` | `Shipped (Today)` |
| Rate limiting | signup, reset, OTP, rivalry invites, extraction | `src/lib/rate-limit.ts` | `Shipped (Today)` |
| RBAC | `role` column; `/admin` 404s for non-admins; every admin action re-checks the role in the DB; last admin cannot be demoted | `src/lib/admin.ts`, `src/lib/admin-actions.ts` | `Shipped (Today)` |
| Leaderboard | every non-suspended player, aggregated stats only, no emails or per-rivalry scores | `src/lib/leaderboard.ts` | `Shipped (Today)` |
| Upload safety | magic-byte checks | `src/lib/image-bytes.ts` | `Shipped (Today)` |
| Headers | CSP, HSTS, frame, referrer, permissions policies (CSP still allows inline/eval scripts for Next.js) | `next.config.ts` | `Shipped (Today)` |
| Route guards | optimistic redirects; pages and actions re-check | `src/proxy.ts` | `Shipped (Today)` |

SMS-based login was removed in `3bd35a1`; there is no SMS provider, gateway or fallback anywhere in the system.

### 4.2 Public profiles vs. peer rivalry privacy — `Next Polish (Immediate)`

Final model:

- Any logged-in user can browse `/leaderboard`, or search any user, and open that user's **overall career profile** (aggregated stats), and can send a rivalry request at any time.
- The profile privacy toggle (`users.public_leaderboard`, to be renamed to reflect peer visibility) controls only whether **non-rivals** can drill into that user's **individual rivalry matchups and match logs**. The rival in a rivalry always sees it; **admins always retain full visibility**.
- Today the flag is stored and editable (profile panel, admin page) but not enforced, because no peer-facing drill-down view exists yet. Enforcement ships together with that view.

### 4.3 Suspension enforcement — `Next Polish (Immediate)`

Password login (`verifyCredentials`) and OTP sending (`sendOtp`) block suspended accounts today. **Google sign-in and already-issued JWT sessions do not**; closing both is an immediate polish item (check suspension at Google account resolution and re-validate on session refresh).

### 4.4 Security roadmap — `Roadmap (Future)`

- Self-serve data export (JSON/CSV) and account deletion.
- Append-only admin audit log.

### 4.5 Verified maturity scorecard (0 none – 5 production-grade)

| Dimension | Verified today | Target after Next Polish | Reasoning |
|---|---|---|---|
| Authentication | 3.5 | 4.5 | Solid password, OTP and Google flows; suspension bypass via Google/JWT |
| Authorization | 4 | 4.5 | DB-checked RBAC; no audit log yet |
| Privacy | 2 | 3.5 | Aggregates only on the leaderboard; peer toggle unenforced; no export/delete |
| Ingestion | 2 | 3.5 | One reliable screenshot path; no abstraction, confidence or dispute flow |
| Analytics | 2 | 3.5 | Strong descriptive layer; indices and EDA widgets pending |
| Prediction / Causal | 0 | 0 | Designed, not built |
| Observability | 1.5 | 2 | Vercel Analytics and server console logs only |

### 4.6 Known debt to clear in Phase 1

Dead `users.phone` column and its unique/E.164 constraints; `otp_codes.channel` is always `email`; `scripts/setup-live-accounts.mjs` still writes phone numbers; `rivalries.a_public` / `b_public` are unused; `match_status` `pending` and `disputed` and `matches.needs_review` have no flow yet.

## 5. Sequenced implementation roadmap

1. **Phase 1 — Security, privacy & profile polish.** Enforce suspension in Google OAuth and JWT sessions; wire peer rivalry privacy against always-visible career profiles, with user search and challenge from the leaderboard; add optional `efootball_id`; drop the dead `users.phone` column.
2. **Phase 2 — Ingestion trust & abstraction.** Introduce `MatchTelemetryIngestor`; add AI green/yellow confidence flags on extracted fields; add the opponent Dispute (`disputed`) flow.
3. **Phase 3 — Tier 1B Rivalry EDA Lab & derived indices.** Ship the five derived football indices and the five EDA widgets on the Bento dashboard.
4. **Phase 4 — Multi-screen batch ingestion & tactical tags.** Multi-screenshot upload (Stats + Ratings + Events) and 1-tap tactical playstyle tags.
5. **Phase 5 — Tier 2 & Tier 3 modeling.** Stage 3A Bivariate Poisson and EWMA forecast (N ≥ 5); Stage 3B Glicko-2, tilt detector and clash matrix (N ≥ 20); Tier 2 causal inference (N ≥ 30 tagged matches).
