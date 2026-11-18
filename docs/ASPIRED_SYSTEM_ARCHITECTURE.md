# PESRIVALS — Aspired System Architecture

> Status: aspirational design. Sections marked **Today** describe what ships; everything else is roadmap.

## 1. Executive vision & PRD alignment

PESRIVALS turns casual eFootball rivalries into a measurable, fair, shareable competitive record. The PRD pillars map to the architecture as follows:

| PRD pillar | Architecture answer |
|---|---|
| Effortless logging | Screenshot ingestion today; zero-touch telemetry later |
| Trustworthy stats | Provenance per match (`source`), admin moderation, confirmed-only aggregation |
| Rivalry depth | Per-rivalry dashboard (Today) and a causal/predictive engine (roadmap) |
| Community | Opt-in global leaderboard of aggregated career stats (Today) |
| Safety & privacy | Hashed secrets, RBAC, rate limits, strict leaderboard isolation |

### 1.1 Decoupled `MatchTelemetryIngestor`

All match data enters through one adapter interface so the source of truth can change without touching analytics:

```ts
interface MatchTelemetryIngestor {
  readonly source: "screenshot" | "manual" | "sheet" | "konami_s2s";
  ingest(input: IngestInput): Promise<CanonicalMatch>; // validated against match-schema.ts
}
```

| Adapter | Status | Notes |
|---|---|---|
| `VisionVlmIngestor` | **Today** | Gemini vision extraction of the post-match stats screen, human-reviewed (`needs_review`) |
| `ManualEntryIngestor` | **Today** | Form entry with the same canonical schema |
| `SheetImportIngestor` | **Today** | One-off Excel history import |
| `KonamiIdIngestor` | Future | KONAMI ID / server-to-server webhooks, signed payloads, idempotent by upstream match id |

**Profile binding.** Each user may bind a 9-digit eFootball Player ID. Binding is verified by a one-time in-game friend/nickname challenge (or the KONAMI ID OAuth hand-off when available). A bound ID lets S2S webhooks resolve which PESRIVALS user owns each side of a match with no screenshot at all. Unbound IDs are never auto-merged.

## 2. Multi-screen batch ingestion roadmap

1. **Stats screen** (Today): possession, shots, passes, tackles, saves.
2. **Player Ratings / Events screen**: per-player ratings, goal/assist timeline, cards, substitutions.
3. **Batch upload**: several screenshots (or a short screen recording) per match, grouped by timestamp and team names.
4. **Keyframe sampling**: for video, sample frames at scene changes (result screen, stats tab, ratings tab), dedupe by perceptual hash, and send only keyframes to the VLM to bound cost.
5. **1-tap tactical tags**: after ingestion the user can tag the match with the playstyle faced (e.g. possession, quick counter, long ball, out wide). Tags are optional, user-owned labels that feed the clash matrix in §3.3.
6. **Review queue**: every field carries a confidence score; low-confidence values are highlighted for confirmation before the match becomes `confirmed`.

## 3. Three-tier data-science pipeline

### 3.1 Tier 1 — Descriptive EDA & derived football indices

Computed per match, per rivalry and per career from confirmed matches only.

| Index | Definition (proxy where telemetry is limited) |
|---|---|
| **Shot Clinical Index** | goals / shots on target, shrunk toward the global mean for small samples |
| **Build-Up Tempo** | passes per minute of possession, from passes and possession % |
| **Progressive Directness** | share of passes that are crosses / long balls (crosses, passes) |
| **Pressing Intensity (PPDA proxy)** | opponent passes / (my tackles + interceptions + fouls) |
| **Goalkeeping Save Efficiency** | saves / opponent shots on target |

Outputs: distributions, rolling windows, radar/bento visuals (the rivalry dashboard is **Today**; the indices are roadmap).

### 3.2 Tier 2 — Causal inference engine

Raw win rates mislead: hosting, opponent strength and lineup choices are confounded. The engine estimates the effect of a *treatment* (e.g. playing a given formation or style) on outcome.

- **Propensity Score Matching / IPTW** with covariates: opponent rating, host seat, session position, own and opponent playstyle tag.
- Overlap diagnostics (standardized mean difference < 0.1 after weighting), trimmed weights, bootstrap CIs.
- Reported as "estimated effect on win probability, with uncertainty", never as a bare number.

### 3.3 Tier 3 — Predictive & sequential engine

| Component | Method |
|---|---|
| Player strength | Hierarchical Bayesian rating or **Glicko-2**, with H2H shrinkage toward each player's global rating for sparse rivalries |
| Form | Global and H2H **EWMA** of result/goal difference |
| Hosting latency bias | Host-seat effect on goals and possession, fitted as a random effect |
| Session fatigue / tilt | Sequential model over matches in a session: goal-difference drift, increased fouls/card proxy after a loss |
| Playstyle clash matrix | Win-rate / goal-difference table of style A vs style B, shrunk by sample size |
| Pre-match forecast | **Bivariate Poisson** goal model (shared-component correlation) giving W-D-L probabilities and exact-score grid, calibrated with reliability plots and Brier score |

Governance: every model is versioned, backtested on a time-ordered holdout, and shown with calibration; no model output is used for moderation or ranking on the public leaderboard.

## 4. Security & privacy audit matrix

| Area | Control | Status |
|---|---|---|
| Passwords | bcrypt cost 12, strength policy | Today |
| Reset tokens | 32-byte random, SHA-256 stored, 15 min, single use | Today |
| Login OTP | 6 digits, SHA-256 stored, 10 min, max 3 attempts, 3 sends / 15 min | Today |
| OTP delivery | Resend email; Fast2SMS hook; phone falls back to recovery email until SMS is configured | Today |
| Enumeration | Generic login errors; OTP send never reveals account existence | Today |
| Rate limiting | DB-backed fixed windows (signup, reset, OTP, invites, extraction) | Today |
| RBAC | `role` column; `/admin` returns 404 to non-admins; every admin action re-checks role in the DB; last admin cannot be demoted | Today |
| Suspension | Suspended accounts cannot log in or request OTPs; hidden from leaderboard | Today |
| Leaderboard privacy | Opt-out flag; aggregated stats only; no emails, phones or per-rivalry scores | Today |
| Upload safety | Magic-byte image checks | Today |
| Headers | CSP and security headers | Today |
| Account takeover | Login alerts, device list, optional TOTP 2FA | Roadmap |
| Data subject rights | Self-serve export and delete | Roadmap |
| Audit trail | Append-only admin action log | Roadmap |
| SMS provider | Production SMS gateway (DLT-registered for India) | Roadmap |

### Maturity scorecard (0 none – 5 production-grade)

| Dimension | Score | Note |
|---|---|---|
| Authentication | 4 | Passwords, OTP, Google; no 2FA yet |
| Authorization | 4 | RBAC with DB re-check; no audit log |
| Privacy | 3 | Opt-out and isolation done; no export/delete flow |
| Ingestion | 3 | VLM + review; no S2S or batch |
| Analytics | 2 | Descriptive only |
| Prediction / causal | 0 | Designed here, not built |
| Observability | 2 | Vercel Analytics only |
