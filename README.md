# PESRIVALS

An eFootball Mobile rivalry tracker. Friends form 1v1 rivalries and log matches from stats-page screenshots.

This repository currently contains the foundation, the database schema, authentication (sign-up, login, Google OAuth) and the rivalry workflow (search, challenge, accept or decline, cancel, a rivalry page shell). Match upload and stats dashboards are not built yet.

## Stack

- Next.js (App Router, TypeScript, `src/` directory, `@/*` import alias)
- Tailwind CSS v4 and shadcn/ui (dark theme only, CSS variables)
- Drizzle ORM and drizzle-kit
- Neon Postgres via `@neondatabase/serverless` (`drizzle-orm/neon-http`)
- Auth.js v5 (`next-auth@beta`) with JWT sessions, `bcryptjs`, `libphonenumber-js`, `zod`
- Vitest for integration tests
- Hosted on Vercel, deployed by pushing to `main`
- npm as the package manager

The app is mobile-first: design at 390px width first.

## Run locally (Windows, PowerShell)

Requires Node.js 20.9 or newer.

```powershell
git clone https://github.com/NamanAgarwal15/PESRIVALS
cd PESRIVALS
npm install
Copy-Item .env.example .env.local
```

Fill in the values in `.env.local` (see the table below), then:

```powershell
npm run dev
```

Open http://localhost:3000. To check the database connection, open http://localhost:3000/api/health. It should return `{"ok":true,"db":true,"target":"local","time":"..."}`.

Other commands:

```powershell
npm run lint
npx tsc --noEmit
npm run build
npm test
```

`npm test` runs the Vitest integration tests against the LOCAL TEST database (it loads `.env.local` only) and deletes every row it creates.

## Environment variables

| Variable | Used for | Lives in |
| --- | --- | --- |
| `DATABASE_URL` | App runtime queries (pooled connection) | `.env.local` for local dev; Vercel project settings for deployments |
| `DATABASE_URL_UNPOOLED` | Local migrations (direct connection) | `.env.local` |
| `GEMINI_API_KEY_1` | Stored for a later feature; no code reads it yet | `.env.local` |
| `GEMINI_API_KEY_2` | Stored for a later feature; no code reads it yet | `.env.local` |
| `AUTH_SECRET` | Signs and encrypts the session cookie. Use a different value per environment | `.env.local`; Vercel project settings |
| `AUTH_GOOGLE_ID` | Google OAuth client id (optional) | `.env.local`; Vercel project settings |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret (optional) | `.env.local`; Vercel project settings |
| `LIVE_DATABASE_URL` | Reference copy of the live pooled URL, for setting Vercel Production | `.env.live.local` |
| `LIVE_DATABASE_URL_UNPOOLED` | Live migrations (direct connection) | `.env.live.local` |

`.env.example` lists every key with an empty value. Both `.env.local` and `.env.live.local` are gitignored (`.env*.local`) and must never be committed.

### Vercel

Set `DATABASE_URL` by hand in the Vercel project settings:

| Vercel environment | Value of `DATABASE_URL` |
| --- | --- |
| Production | The `LIVE_DATABASE_URL` value from `.env.live.local` |
| Preview and Development | The `DATABASE_URL` value from `.env.local` |

## Local and live separation

There are two separate Neon databases: a LOCAL TEST database and the LIVE database.

1. `npm run dev` only ever uses the LOCAL TEST database. Next.js loads `.env.local`; nothing in the app reads `.env.live.local`.
2. The LIVE database is reached in exactly two ways: the Vercel Production deployment, and `npm run db:migrate:live`.
3. Use the pooled URL at runtime and the unpooled (direct) URL for migrations.
4. Never print, log, or commit a connection string or key. Refer to them by variable name.
5. `/api/health` reports only `ok`, `db`, `target` (`local` in development, otherwise `remote`) and `time`. It never returns a host, user, database name, or error detail.

## Authentication

Auth.js v5 with JWT sessions (30 days, no database adapter). The configuration is in `src/auth.ts`; the database logic is in `src/lib/auth-helpers.ts` and is what the tests exercise.

- **Sign up** (`/signup`): username, display name, password, optional email, optional phone. Usernames are lowercase `^[a-z0-9_]{3,20}$`, cannot be a reserved word (`admin`, `home`, `settings`, ...) and cannot be only digits. Emails are stored lowercase. Phones are stored in E.164 form and are read as Indian numbers unless they start with `+`. Passwords are 8 to 72 characters, hashed with bcrypt (cost 12).
- **Log in** (`/login`): one identifier field. Anything with `@` is an email; anything starting with `+` or made only of digits, spaces and dashes is a phone; everything else is a username. Every failure shows the same message, `Incorrect login details`.
- **Throttle**: 5 failed attempts for one identifier within 15 minutes lock that identifier for 15 minutes (`login_throttle` table). A successful login clears the counter.
- **Google**: the button and provider only exist when both `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are set. The redirect URI to register with Google is `<origin>/api/auth/callback/google`. A Google account is matched to a user by an existing `oauth_accounts` link, or else by a verified email; otherwise a new user is created with a temporary `g_<hex>` username and `onboarded = false`.
- **Onboarding** (`/onboarding`): users with `onboarded = false` must claim a permanent username before they can reach `/home`.
- **Protection**: `src/proxy.ts` redirects signed-out visitors away from `/home` and `/onboarding` (and signed-in visitors away from `/login` and `/signup`). The pages and server actions check the session again themselves.

In Server Components, read the session with `getSession()` from `src/lib/session.ts`, inside a `<Suspense>` boundary.

## Rivalries

The database logic is in `src/lib/rivalry-helpers.ts` (what the tests exercise); `src/lib/rivalry-actions.ts` wraps it in server actions that read the session.

- **Search** (on `/home`): type a username prefix, with or without `@`, at least 2 characters. Up to 10 onboarded, non-placeholder users other than yourself are listed, each with the right button: `Challenge`, `Pending`, `Accept` or `Open Rivalry`.
- **Challenge**: creates a `pending` rivalry. If the other player had already challenged you, challenging back accepts it. A declined request can be sent again by either player (the same row is reused). An active or blocked pair is refused.
- **Respond**: only the player who received a request can accept or decline it. **Cancel**: only the sender can, and it deletes the pending row.
- **`/rivalry/[id]`**: visible only to the two members of an `active` rivalry. Everyone else gets a 404. Because a streamed page cannot change its status code, `src/proxy.ts` makes that decision before rendering, and the page checks again.

Always build the pair with `canonicalPair()` so the lower uuid is `user_a` (see the a/b ordering rule below).

## Database scripts

```powershell
npm run db:generate
npm run db:migrate:local
npm run db:migrate:live -- --confirm-live
```

- `db:generate` creates migration files from `src/db/schema.ts`.
- `db:migrate:local` applies migrations to the LOCAL TEST database using `DATABASE_URL_UNPOOLED` from `.env.local`.
- `db:migrate:live` applies migrations to the LIVE database using `LIVE_DATABASE_URL_UNPOOLED` from `.env.live.local`. It refuses to run without `--confirm-live`, and that check happens before any file is loaded or connection is attempted. When it runs, it prints the word `LIVE` and the last 12 characters of the hostname so you can confirm the target.

## Theme

All colours are CSS variables defined in `src/app/globals.css`. Do not hard-code hex values anywhere else; use the Tailwind tokens (`bg-primary`, `text-muted-foreground`, `text-win`, `bg-accent-pink`, and so on). Headings use Barlow Condensed and body text uses Inter, both loaded with `next/font`.

## Database

The schema lives in `src/db/schema.ts`; migrations are generated into `./drizzle` and committed.

### Tables

- **`users`**: one row per person. `username` is unique and must match `^[a-z0-9_]{3,20}$`. `email` and `phone` are optional but unique. `is_placeholder` marks a user created on someone's behalf who has not signed up yet. `onboarded` is false only for Google sign-ups that have not chosen a username yet. The database also requires `email` to be lowercase and `phone` to be E.164.
- **`oauth_accounts`**: one row per external identity (provider plus provider account id, unique together) linked to a user.
- **`login_throttle`**: failed-login counter per identifier (`key`), with the window start and an optional `locked_until`.
- **`rivalries`**: a 1v1 pairing of two users, with a `status` (`pending`, `active`, `declined`, `blocked`), who requested it (`requested_by`), and a public flag per side (`a_public`, `b_public`).
- **`matches`**: one row per match in a rivalry, numbered by `match_no` (1-based, unique within the rivalry). Holds each side's team, goals, and 13 optional stats per side (`user_a_<stat>` / `user_b_<stat>`), plus `source` (`import`, `screenshot`) and `status` (`confirmed`, `pending`, `disputed`).

Deleting a user deletes their rivalries, and deleting a rivalry deletes its matches.

### The a/b ordering rule

A pair of users can have only one rivalry. To guarantee that, the user with the **lower uuid is always `user_a`** and the other is `user_b`. The database enforces this itself (`CHECK user_a_id < user_b_id` plus a unique constraint on the pair), so code must sort the two ids before inserting a rivalry.

On a match, `user_a_*` and `user_b_*` columns always refer to the rivalry's `user_a` and `user_b`. They do not mean home/away or "me/opponent"; use `host_user_id` for who hosted.

The database also rejects: a `requested_by` who is not one of the two users, goals outside 0 to 99, possession outside 0 to 100, shots on target above shots, and successful passes above passes. Stats left empty (NULL) pass these checks.

### Changing the schema

```powershell
npm run db:generate
npm run db:migrate:local
```

Edit `src/db/schema.ts`, generate a migration, read the generated SQL in `./drizzle`, then apply it to the LOCAL TEST database. Commit the migration files with the schema change.

### Live database

The LIVE database has **not** been migrated yet; it has no tables. Sign-up and login will not work on Production until both migrations (`0000`, `0001`) are applied and `AUTH_SECRET` is set in Vercel. When ready:

```powershell
npm run db:migrate:live -- --confirm-live
```
