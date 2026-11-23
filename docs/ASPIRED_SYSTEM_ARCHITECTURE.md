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
| Trustworthy stats | Confirmed-only aggregation; AI confidence flags and opponent dispute | `Shipped (Today)` |
| Rivalry depth | Per-rivalry Bento dashboard and career stats | `Shipped (Today)` |
| Community | Global leaderboard with rivalry requests | `Shipped (Today)` |
| Safety & privacy | Hashed secrets, RBAC, rate limits; peer privacy model, suspension enforcement, audit log, soft delete, data export/delete, anti-sybil flags | `Shipped (Today)` |

### 1.0 Ingestion as it exists

Screenshot ingestion is the primary live path. Historical data was loaded by one-off Excel scripts; there is no manual-entry path and none is planned.

| Path | Code | `matches.source` | Status |
|---|---|---|---|
| Screenshot extraction | `src/lib/gemini-extract.ts` (`extractMatchFromScreenshot`), orchestrated by `src/lib/match-helpers.ts` (`extractForMember`, save), exposed at `src/app/api/rivalry/[id]/extract/route.ts` | `screenshot` | `Shipped (Today)` |
| Historical Excel import | `scripts/seed-sheet.mjs`, `scripts/import-live-history.mjs`, `scripts/sheet-parser.mjs` | `import` | `Shipped (Today)` (one-off) |

Schema facts (`src/db/schema.ts`): `match_source` = `import | screenshot`; `match_status` = `confirmed | pending | disputed` (only `confirmed` is written today); `matches.needs_review` exists but is always saved as `false`. Stats are 13 nullable per-side columns (possession, shots, shots on target, fouls, offsides, corners, free kicks, passes, successful passes, crosses, interceptions, tackles, saves).

### 1.1 `MatchTelemetryIngestor` adapter layer — `Shipped (Today)`

Today the screenshot reader and the Excel scripts are unrelated code. The refactor puts them behind one interface so the rest of the app only deals with a canonical match:

```ts
interface MatchTelemetryIngestor {
  readonly source: "screenshot" | "import" | "konami_s2s";
  ingest(input: IngestInput): Promise<CanonicalMatch>; // validated by match-schema.ts
}
```

| Adapter | Source | Status |
|---|---|---|
| `VisionVlmIngestor` (wraps `gemini-extract.ts`) | `screenshot` | `Shipped (Today)` |
| `SheetImportIngestor` (validates parsed sheet rows) | `import` | `Shipped (Today)` |
| `KonamiIdIngestor` (signed S2S webhooks, idempotent by upstream match id) | `konami_s2s` | `Roadmap (Future)` — only if Konami ever opens an external API |

### 1.2 Two-layer trust flow — `Shipped (Today)`

1. **AI confidence flags (before saving).** Each extracted field is shown **green** (confident) or **yellow** (needs a look). Yellow is raised for low model confidence or blurry OCR, and for internal inconsistencies such as `shotsOnTarget > shots`, `successfulPasses > passes`, possession not summing to ~100, or a score that disagrees with other fields. The uploader fixes yellow fields before confirming.
2. **Instant save plus opponent dispute (after saving).** The match is saved as `confirmed` immediately so logging stays fast. The opponent sees a **Dispute** button; using it moves the match to `disputed` (a status that already exists in the enum) for peer or admin resolution. Disputed matches are excluded from analytics and the leaderboard until resolved, and `needs_review` is set when any field was yellow.

### 1.3 Optional eFootball Player ID — `Shipped (Today)`

An optional `efootball_id` profile field (9 digits, unique when set) that users can display and copy so rivals can add each other in-game. It is display-only today. If a KONAMI S2S API ever exists, the same field becomes the identity binding key; unbound IDs are never auto-merged.

## 2. Screenshot ingestion capabilities

| Capability | Status |
|---|---|
| Single Full Time stats screen extraction | `Shipped (Today)` |
| Client-side image compression (max 1600px, JPEG 0.85) so uploads stay under Vercel's 4.5 MB body limit (`src/components/matches/upload-match-panel.tsx`) | `Shipped (Today)` |
| Gemini fallback chain: 3 models × 2 API keys inside a 50 s budget; upstream failure reasons logged server-side | `Shipped (Today)` |
| Magic-byte PNG/JPEG/WebP validation (`src/lib/image-bytes.ts`) | `Shipped (Today)` |
| `MatchTelemetryIngestor` interface (`src/lib/ingestors/`) wrapping `VisionVlmIngestor` (screenshot) and `SheetImportIngestor` (historical sheet rows) | `Shipped (Today)` (Phase 2) |
| Green / yellow per-field confidence: model self-reported uncertainty plus deterministic checks (shots on target > shots, successful passes > passes, possession ≠ 100, missing stats); any yellow sets `needs_review` | `Shipped (Today)` (Phase 2) |
| Opponent Dispute flow: matches save as `confirmed` instantly; a rival or admin can flag them `disputed`, which pauses them in all W-D-L, career and leaderboard totals until a member or admin resolves them | `Shipped (Today)` (Phase 2) |
| Single-screenshot-only ingestion. Multi-screen batch upload and video keyframe sampling are **not planned**; the Full Time stats screen stays the only input | `Decision` |
| 1-tap match context pills (Phase 4): **Playstyle** (*Possession Game, Quick Counter, Long Ball Counter, Out Wide, Long Ball*), **Host / Session memory**, **Extra Time / Penalties**, **Match Stakes / Vibe** | `Shipped (Today)` (Phase 4; migration `0005`) |

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

### Tier 1B — Exploratory Rivalry Lab & derived football indices — `Shipped (Today)` (Phase 3)

Implemented as pure, null-safe functions in `src/lib/rivalry-analytics.ts` (confirmed matches only; zero denominators and legacy null stats give `N/A`, never `NaN`/`Infinity`) and rendered in the Visual Analysis tab by `src/components/dashboard/eda-lab.tsx`. The Shot Clinical Index uses `k = 10`.

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

### Tier 2 — Causal inference engine — `Shipped (Today)` (Phase 5; gated at N ≥ 30 tagged matches)

Propensity Score Matching / IPTW with opponent rating, host seat and playstyle tag as covariates, plus bootstrap confidence intervals and overlap diagnostics. **Gated:** it unlocks only at **N ≥ 30 tagged matches** per rivalry. Until then the UI shows a readiness indicator (for example "12 / 30 tagged matches"). Results are shown as an estimate with uncertainty, never a bare number. Depends on tactical tags (§2).

### Tier 3 — Predictive & sequential engine — `Shipped (Today)` (Phase 5; `src/lib/predictive-analytics.ts`)

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

### 4.2 Public profiles vs. peer rivalry privacy — `Shipped (Today)`

Final model:

- Any logged-in user can browse `/leaderboard`, or search any user, and open that user's **overall career profile** (aggregated stats), and can send a rivalry request at any time.
- The profile privacy toggle (`users.public_leaderboard`, to be renamed to reflect peer visibility) controls only whether **non-rivals** can drill into that user's **individual rivalry matchups and match logs**. The rival in a rivalry always sees it; **admins always retain full visibility**.
- Today the flag is stored and editable (profile panel, admin page) but not enforced, because no peer-facing drill-down view exists yet. Enforcement ships together with that view.

### 4.3 Suspension enforcement — `Shipped (Today)`

Password login (`verifyCredentials`) and OTP sending (`sendOtp`) block suspended accounts today. **Google sign-in and already-issued JWT sessions do not**; closing both is an immediate polish item (check suspension at Google account resolution and re-validate on session refresh).

### 4.4 Security roadmap — `Shipped (Today)` (audit log, export/delete; Phase 5)

- Self-serve data export (JSON/CSV) and account deletion.
- Append-only admin audit log.

### 4.5 Verified maturity scorecard (0 none – 5 production-grade)

| Dimension | Original (pre-Phase 1) | Now (all 5 phases shipped) | Reasoning |
|---|---|---|---|
| Authentication | 3.5 | 4.5 | Password, OTP, Google; suspension enforced everywhere; 60 s revalidation; hardened cookie; common-password blocklist |
| Authorization | 4 | 4.5 | DB-checked RBAC, ownership checks, append-only admin audit log |
| Privacy | 2 | 4 | Peer privacy enforced, self-serve export and account deletion, hashed device and IP data |
| Ingestion | 2 | 4 | Ingestor abstraction, green/yellow confidence, disputes, dedup, 1-tap context, soft delete |
| Analytics | 2 | 4 | Tier 1A/1B indices and EDA Lab, Tier 2/3 forecast, ratings, tilt and causal estimates (data-gated) |
| Prediction / Causal | 0 | 3.5 | Bivariate Poisson forecast, Glicko-2, IPTW with bootstrap CIs; needs real match volume to be sharp |
| Observability | 1.5 | 3 | Structured redacted security events and the admin audit log; no external alerting yet |

### 4.6 Known debt (Phase 1 cleared it)

Dead `users.phone` column and its unique/E.164 constraints; `otp_codes.channel` is always `email`; `scripts/setup-live-accounts.mjs` still writes phone numbers; `rivalries.a_public` / `b_public` are unused; `match_status` `pending` and `disputed` and `matches.needs_review` have no flow yet.

### 4.7 Engineering additions (Phases 3–5)

- **Shipped (Phase 3):** leaderboard cached with `unstable_cache` (tag `leaderboard`, 60 s) and expired with `revalidateTag("leaderboard", { expire: 0 })` on match save/dispute/resolve, display-name change, and admin suspend/visibility/match-delete; in-memory SHA-256 screenshot dedup (50 entries, 1 h TTL) so a re-uploaded identical image skips Gemini; rate limiting adds a per-IP upload bucket using `x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for`.
- **Shipped (Phase 4):** 60-second JWT revalidation window: `suspended` and `role` are re-read from Neon at most once per 60 s (always on sign-in and on `unstable_update`), instead of on every request.
- **Deployment note:** keep the Vercel function region next to the Neon database. That is a Vercel/Neon dashboard setting, deliberately not hardcoded in `vercel.json` or code.

## 5. Sequenced implementation roadmap

1. **Phase 1 — Security, privacy & profile polish.** `Shipped (Today)` (commit `7873e69`). Enforce suspension in Google OAuth and JWT sessions; wire peer rivalry privacy against always-visible career profiles, with user search and challenge from the leaderboard; add optional `efootball_id`; drop the dead `users.phone` column.
2. **Phase 2 — Ingestion trust & abstraction.** `Shipped (Today)`, plus change display name (2–50 characters). Introduce `MatchTelemetryIngestor`; add AI green/yellow confidence flags on extracted fields; add the opponent Dispute (`disputed`) flow.
3. **Phase 3 — Tier 1B Rivalry EDA Lab & derived indices.** `Shipped (Today)`: the five derived football indices and five EDA widgets on the Bento dashboard, plus hardening (below).
4. **Phase 4 — Match context pills & Stubborn Web Push.** `Shipped (Today)`. Single screenshot only (no multi-screen, no video). Add 1-tap context pills at save time: Playstyle, Host / Session memory, Extra Time / Penalties, Match Stakes / Vibe. Add **Stubborn Web Push Notifications**: a Service Worker with VAPID keys, persistent alerts using `requireInteraction: true`, and a deliberately multi-step in-app opt-out (several confirmation screens) rather than one-tap disable.
5. **Phase 5 — Tier 2 & Tier 3 modeling, anti-sybil, governance.** `Shipped (Today)`. Stage 3A Bivariate Poisson and EWMA forecast (N ≥ 5); Stage 3B Glicko-2, tilt detector and clash matrix (N ≥ 20); Tier 2 causal inference (N ≥ 30 tagged matches).

## 6. OWASP Top 10:2025 mapping

| OWASP | Control | Status |
|---|---|---|
| A01 Broken Access Control | Session-scoped ownership on every action; DB-checked RBAC; push endpoints must be `https`, a public host (loopback, `10.*`, `172.16–31.*`, `192.168.*`, `169.254.*`, IPv6 local and IPv4-mapped forms blocked, DNS answers checked, fail closed) and are stored under `session.user.id` only | `Shipped (Today)` (Phase 4) |
| A02 Security Misconfiguration | HSTS, `nosniff`, strict referrer, `Permissions-Policy` (camera, microphone, geolocation, payment off), CSP with `frame-ancestors 'none'`, `worker-src 'self'`, `object-src 'none'`, `connect-src` allowlist (`next.config.ts`) | `Shipped (Today)` (Phase 4) |
| A03 Software Supply Chain | `npm run security:audit` (`npm audit --omit=dev --audit-level=high`); lockfile committed | `Shipped (Today)` (Phase 4); findings tracked below |
| A04 Insecure Design | Rate limits (signup, reset, OTP, invites, extraction per user and per IP, push subscribe, disputes); disputes pause stats; push keys encrypted at rest | `Shipped (Today)` |
| A05 Injection / Misconfiguration | Zod validation on all inputs, parameterised Drizzle queries, magic-byte image checks, allowlisted match-context values | `Shipped (Today)` |
| A07 Authentication Failures | Hardened session cookie (`__Secure-` prefix, `httpOnly`, `SameSite=Lax`, `Secure`), 7-day max age, 60 s revalidation, suspension enforced on Google and JWT, common-password blocklist on signup and reset | `Shipped (Today)` (Phase 4) |
| A08 Integrity Failures | No client-trusted role or ownership; server recomputes review flags; service worker is same-origin only | `Shipped (Today)` |
| A09 Logging & Alerting | `src/lib/security-log.ts`: structured JSON events (auth blocks, rate-limit hits, invalid push endpoints, push pruning, dispute activity) with secrets and PII redacted | `Shipped (Today)` (Phase 4) |
| A10 Mishandling Exceptional Conditions | Push routes and sending fail closed with generic errors; a failed push never breaks a match save | `Shipped (Today)` (Phase 4) |
| A06 Insecure Design / anti-abuse | Device fingerprint (client-side SHA-256, no raw buffers), anti-sybil detector (self-rivalry, account farm, score-farming cadence) that only raises admin-review flags | `Shipped (Today)` (Phase 5) |
| A08/A09 Integrity & Audit | Append-only `admin_audit_logs`, soft-deleted matches kept for forensics | `Shipped (Today)` (Phase 5) |

## 7. Implementation progress, known caveats & next steps (living)

### Progress so far
- **Phase 1** (`7873e69`) suspension enforcement, public profiles, peer privacy, eFootball ID, migration `0004`.
- **Phase 2** (`810a65b`) `MatchTelemetryIngestor`, green/yellow confidence, dispute flow, display-name edit.
- **Phase 3** (`bb5c239`) five derived indices, EDA Lab, leaderboard cache, screenshot dedup, trusted IP headers.
- **Phase 4** 1-tap context pills (playstyles, stakes/vibe, extra time, host memory in `localStorage`), stubborn Web Push (service worker, VAPID, `requireInteraction`, AES-256-GCM key storage, 3-step opt-out), 60 s JWT revalidation, OWASP hardening, migration `0005` (applied to live Neon).

- **Phase 5** predictive/causal engine (Match Lab), device fingerprint + anti-sybil flags, soft-delete matches, admin audit log, Flagged Activity queue, self-serve export and account deletion, migration `0006` (applied to live Neon).
- **Phase 6A** exact-score fix (forecast grid is now `0..6+` and the headline score comes from an unpooled `0..15` table, so a pooled bucket is never shown as a scoreline such as `4–4`), asymmetric **Personal Win Drivers** (each player's own stats in wins vs losses, with lift and point-biserial `r`), plain-English explanations under Forecast, Glicko-2, Tilt and Causal, a clearer rivalry-wide subtitle on Stat vs Goal Difference, and a Postgres append-only trigger on `admin_audit_logs` (migration `0007`, applied to local and live Neon).
- **Phase 6B** `/stats` is now the **Personal Career Lab** (`src/lib/career-lab.ts`, `src/components/stats/career-lab.tsx`): every rivalry normalised to "me vs rival" by canonical `user_a`/`user_b` and renumbered globally; career Derived Indices, Personal Win Drivers, tilt/streak summary and a career Glicko-2 rating (from 10 matches); an Opponent-by-Opponent Matrix (W-D-L, win %, goals per game, possession, shots on target, clinical index, top playstyle, and win %/possession shifts vs your career, with 0-match rivals shown as N/A); and a Matchday Coach Briefing of 3 insights cached in the new `user_insights` table (migration `0008`, applied to local and live Neon). Insights are keyed by `sha256(userId:confirmedCount:latestMatchId)`, so a refresh without new matches makes zero model calls; at most 1 AI generation per user per UTC day (it was 3 per 24 h before Phase 7), only with 3+ matches and configured keys; the prompt carries sanitised numeric summaries plus the last 7 days of titles to avoid; a rule-based fallback always works.
- **Phase 6C** (no migration) the **What-If Simulator** (`src/lib/match-simulator.ts`, `match-simulator.tsx`, in Match Lab and on `/stats`) and the scoped **Rivalry Coach** (`src/lib/coach-chat.ts`, `POST /api/coach/chat`, `rivalry-coach-chat.tsx` on `/stats` and `/rivalry/[id]`). The simulator uses no AI: every input is hard-clamped (minute 0-90, goals 0-20, possession 15-85, shots on target 0-30, bad values fall back to defaults), remaining expected goals are scaled by `max(0.05, (90 - minute) / 90)` and adjusted for host seat, playstyles, possession edge and shots-on-target edge, the bivariate Poisson remaining-goals table is added onto the current score, and Win/Draw/Loss are rounded by largest remainder so they are integers summing to exactly 100.

- **Codebase hygiene & architecture sweep** (no schema or migration changes, no user-facing formula, rate-limit or layout changes):
  - *Duplicated helpers consolidated:* one `src/lib/hash.ts` `sha256Hex` replaces four copies (OTP, password reset, extract cache, anti-sybil, career-lab); a shared `src/lib/gemini-text.ts` client (key loading plus the model x key fallback loop) replaces two copies in career insights and the coach; `stripUnsafe` now delegates to `sanitizeText`; one `src/lib/api-guard.ts` (`apiUser`, `noStoreJson`) and `src/lib/request-origin.ts` (`sameOrigin`) replace the push-only guard and three private JSON helpers; the leaderboard's `CareerMatch` row type was renamed `ActiveMatchRow` so it no longer clashes with the oriented `CareerMatch` in career-lab.
  - *API auth made uniform:* every JSON route (push subscribe/unsubscribe, fingerprint, export, coach, screenshot extract) now goes through `apiUser`: same-origin for mutations, signed in, and an account that still exists and is not suspended, checked in the database. The extract route previously relied only on the 60 s session window while spending Gemini quota.
  - *Input hardening (bugs found and fixed):* `disputeMatch` threw a TypeError when called with a non-string reason; `updateEfootballIdAction`, `parseEfootballId`, `setProfileVisibilityAction` and `disputeMatchAction` now accept `unknown` and validate; the profile-visibility toggle no longer leaves an unhandled promise and reverts if the save fails; non-null assertions on database/env data were removed from `push.ts` (VAPID) and `profile-actions.ts`.
  - *Query hygiene:* every stats, analytics, leaderboard, profile, export and career query was re-audited for `status = 'confirmed'` and `deleted_at IS NULL` (a regression test now asserts it); added safety ceilings to previously unbounded lists (leaderboard 100,000 matches and 20,000 users, a user's rivalries 500 and relation map 1,000).
  - *Large components decomposed with identical DOM and props:* `rivalry-dashboard.tsx` (742 lines) into `overview-tab.tsx`, `analysis-tab.tsx`, `dashboard-parts.tsx` and the filter shell; `upload-match-panel.tsx` (488 lines) into `upload-helpers.ts` and `upload-parts.tsx`.
  - *Dead code and dependencies:* removed the unused `Confidence` and `RivalryDecision` types and the push-only guard module; verified there are no `any` types, no unimported source files (`src/lib/utils.ts` is the shadcn alias target) and no unreferenced packages (`react-dom` and the `@types/*` packages are required by the toolchain).
  - *Left as is, on purpose:* Server Actions rely on the 60 s session revalidation window rather than a per-action database check (the heavy or costly routes above do check the database); the leaderboard still aggregates in memory (cached 60 s, now capped); `src/lib/rivalry-analytics.ts` (about 800 lines) is a cohesive set of pure functions and was not split.

- **Phase 7 (feature branch `feat/quotas-6key-admin-oversight`, not yet merged to `main`)** Option A quota guardrails, 6-key Gemini pool, and admin oversight:
  - **6-key pool:** `src/lib/gemini-keys.ts` reads `GEMINI_API_KEY_1` to `GEMINI_API_KEY_6` and skips unset or empty slots; both the vision extractor and the shared text client (`gemini-text.ts`) walk models x keys inside their time budget and only ever log the slot label (`KEY_n`). Works today with the existing two keys; adding more needs no code change.
  - **Quotas (Option A), UTC-day buckets in `rate_limits`:** screenshot extraction 10 per hour and 30 per UTC day per user (plus the existing per-IP bucket and the SHA-256 result cache); AI Matchday Briefing 1 per user per UTC day (snapshot-hash cache and rule-based fallback kept); Rivalry Coach 5 AI answers per user per UTC day, with the existing 15 per hour per user and 40 per hour per IP limits. The coach reserves a daily unit atomically (`reserveQuota`, which never counts a refused attempt) and refunds it if the model call fails; injection refusals and rule-based answers are free.
  - **Coach UI:** `/stats` and `/rivalry/[id]` pass the initial remaining quota, `/api/coach/chat` returns `remainingToday`, the badge reads "X / 5 AI asks left today", and at 0 the free-text box is disabled with "Daily AI Coach limit reached — resets at midnight UTC. Instant rule-based tips & What-If Simulator remain available." The four starter chips keep working (rule-based answers) and the What-If Simulator is unaffected.
  - **`coach_chat_logs` (migration `0009`, applied to local and live Neon, additive):** every coach exchange is stored sanitised, with source (`ai`, `deterministic`, `guard`), a flag and reason (injection attempts and AI refusals are flagged), and the rivalry only when the user is a member of it; indexes on `(user_id, created_at)` and `(flagged, created_at)`; deleted with the user, rivalry link set to null with the rivalry.
  - **Admin Quota Refresh:** `resetUserQuotaAction` (Zod-validated, `coach` | `extract` | `briefing` | `all`) deletes the target's hourly and daily `rate_limits` keys and today's AI briefing rows, and writes a `user.reset_quota` audit row.
  - **Admin Rivalry Coach Chat Reader:** `/admin` shows all persisted coach chats by default (user, rivalry scope, time, full prompt and reply, source and flag badges), with an All Chats / Flagged Only toggle, a username filter and 20 per page; opening it writes a `coach.chats_viewed` audit row (at most once per 5 minutes per admin). Both admin entry points re-verify in the database that the caller is a non-suspended admin; the reader never exposes system prompts or keys.

### Known problems & caveats
- **Coach logs contain user questions** and the coach's replies, visible to admins by design (abuse review). On `feat/quotas-6key-admin-oversight` the `/privacy` page now discloses this (sanitised prompts and replies logged for anti-abuse moderation, safety oversight and service quality; Google Gemini processes AI answers) and a **30-day rolling retention** is enforced: `pruneExpiredCoachChatLogs()` in `src/lib/coach-chat.ts` deletes rows older than 30 days in batches of 1,000, runs after about 2% of coach responses (via `after()`, so users never wait) and whenever an admin opens the chat reader; account deletion also deletes the user's chats immediately, and removing a user cascades. It never touches `admin_audit_logs`. There is no scheduled job, so a quiet site prunes only when one of those happens.
- Hourly and daily limits are in the database, so a reset by an admin takes effect immediately; IP buckets are not reset by the quota refresh.
- **Coach chat security posture:** the client can only send `{message, history, rivalryId}`; `system` or any unknown role is rejected; messages are 1-300 characters after `<`, `>` and control characters are stripped; history is capped at 6 turns (assistant items 600 characters); the model gets a separate system instruction that declares `<telemetry_context>`, `<user_query>` and `<prior_turn>` as untrusted data and answers off-topic or override attempts with a fixed refusal; only the signed-in user's confirmed matches (numbers and sanitised rival names) are in the context, and a rivalry id the user is not in grants nothing; `maxOutputTokens` is 350; replies are stripped to plain text, capped and replaced by the refusal if they echo the prompt; the UI renders text nodes only (no raw HTML); limits are 15 per hour per user and 40 per hour per IP in the existing `rate_limits` table, logged through `security-log.ts`; the route re-checks the account is not suspended and requires same-origin. Obvious injection phrases are refused without spending a model call. Residual risks: model output can still be wrong or off-topic, and the injection phrase filter is a heuristic, not a guarantee. The 60 s session window applies to suspension here too.
- **Simulator** modifiers (host +8%/-6%, small playstyle multipliers, possession and shots-on-target edges) are hand-set heuristics, not fitted to data; use it for intuition, not betting.
- **Career Lab insights:** the AI briefing is capped at 1 generation per user per UTC day and depends on the Gemini keys; otherwise the rule-based coach is shown. Two simultaneous first visits could both call the model once (the unique index stores only one result). The briefing text is generated, so treat it as guidance, not analysis. Career ratings treat each rival as a separate opponent starting at 1500, so they are only a rough cross-rival comparison.
- **Forecast quality** depends on volume: Stage 3A unlocks at 5 matches, Stage 3B at 20, Tier 2 at 30 *tagged* matches (host plus your playstyle). Estimates are shown with uncertainty and are not guarantees. Draws decided on penalties are treated as draws.
- **Fingerprint limits:** the hash is a hardware/rendering signal, not an identity. Two siblings on one device or a shared family PC will produce flags; that is why every flag needs an admin decision and nothing is automatic. Browsers that randomise canvas/WebGL can evade it.
- **Soft delete** keeps rows (and who deleted them) in the database indefinitely; there is no purge job yet.
- **Account deletion** anonymises rather than removes rows so rivals keep their history; match results the player logged remain, under the name "Deleted player".
- **Audit log** is now append-only in the database: a `BEFORE UPDATE OR DELETE` trigger (migration `0007`) raises on any change. The one deliberate exception is the `ON DELETE SET NULL` foreign key: when a user is deleted, Postgres may null `actor_user_id` and nothing else, so user cleanup keeps working. A superuser could still drop the trigger.
- Anti-sybil score-farming check runs when a match is saved (non-blocking); device checks run on a daily client check-in.
- Web Push is **live**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `PUSH_ENCRYPTION_KEY` are configured in Vercel and the app has been redeployed (confirmed by the owner). If any of them is ever removed the banner hides and sending becomes a quiet no-op, and in production a missing `PUSH_ENCRYPTION_KEY` makes subscribing fail (by design). Changing `PUSH_ENCRYPTION_KEY` orphans existing subscriptions. Delivery has not yet been tested on real devices.
- iOS only delivers web push to an installed home-screen app.
- Because of the 60 s window, a suspension or role change can take up to 60 s to reach an open session.
- The "stubborn" banner has no dismiss button by design; users who deny permission see a "blocked" message.
- The screenshot dedup cache is per server instance and in memory.
- Resend still needs a verified sending domain before password reset and OTP emails reach everyone.
- Playstyle, stakes and extra-time data is collected but not yet used by any analytics (Phase 5 inputs).
- A re-subscribe from the same browser endpoint under another account moves that subscription to the new account.
- `connect-src` is an allowlist but the CSP still needs `'unsafe-inline'`/`'unsafe-eval'` for scripts (Next.js); a nonce-based CSP is future work.
- `npm run security:audit` (high and above, production deps) passes after moving the script-only `xlsx` package to devDependencies; moderate advisories in dev tooling remain.

### Planned next steps
0. Review the first real anti-sybil flags and tune thresholds, and decide a purge policy for soft-deleted matches. (The audit-log database guard is done in Phase 6A.)
1. Test Web Push delivery on Android Chrome and desktop (the four env vars are already set in Vercel).
2. Verify a Resend sending domain.
3. Phase 5 is shipped; remaining ideas are above (anti-sybil tuning, audit-log DB guard) plus real-world validation of the forecast calibration once rivalries have 30+ matches.
4. Nonce-based CSP and an `npm audit` clean-up pass.

**Later checklist (not done yet):**
- [ ] Add `GEMINI_API_KEY_3` to `GEMINI_API_KEY_6` (from 2 additional Google accounts) in Vercel. The 6-key pool is already supported in code; no code change is needed.
- [ ] Test the Vercel Preview of `feat/quotas-6key-admin-oversight`, then merge it into `main` and redeploy (live Neon already has migration `0009`).
- [x] Privacy copy and 30-day `coach_chat_logs` retention (done on the feature branch).
5. **Roadmap complete.** Phases 1 to 6C are shipped. What remains is operational: add the push env vars in Vercel, verify the Resend domain, smoke-test the UI in a browser, tune anti-sybil thresholds with real flags, fit the simulator modifiers to real data, and move to a nonce-based CSP.
