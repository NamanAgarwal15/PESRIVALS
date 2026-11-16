# PESRIVALS

An eFootball Mobile rivalry tracker. Friends form 1v1 rivalries and log matches from stats-page screenshots.

This repository currently contains only the foundation: an empty, deployed app with a database connection and a health check. There is no authentication, schema, or dashboard yet.

## Stack

- Next.js (App Router, TypeScript, `src/` directory, `@/*` import alias)
- Tailwind CSS v4 and shadcn/ui (dark theme only, CSS variables)
- Drizzle ORM and drizzle-kit
- Neon Postgres via `@neondatabase/serverless` (`drizzle-orm/neon-http`)
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
```

## Environment variables

| Variable | Used for | Lives in |
| --- | --- | --- |
| `DATABASE_URL` | App runtime queries (pooled connection) | `.env.local` for local dev; Vercel project settings for deployments |
| `DATABASE_URL_UNPOOLED` | Local migrations (direct connection) | `.env.local` |
| `GEMINI_API_KEY_1` | Stored for a later feature; no code reads it yet | `.env.local` |
| `GEMINI_API_KEY_2` | Stored for a later feature; no code reads it yet | `.env.local` |
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

- **`users`**: one row per person. `username` is unique and must match `^[a-z0-9_]{3,20}$`. `email` and `phone` are optional but unique. `is_placeholder` marks a user created on someone's behalf who has not signed up yet.
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

The LIVE database has **not** been migrated yet; it has no tables. When ready:

```powershell
npm run db:migrate:live -- --confirm-live
```
