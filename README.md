# Job Scraper

Checks MyJobMag Kenya, BrighterMonday, JobWebKenya and Opportunities for Young Kenyans
(every minute) plus LinkedIn (one search every 2 min, rotating) for new jobs and sends
them to Telegram. Runs free on Cloudflare Workers — no card needed.

```
Cron (every minute) → job sites + LinkedIn → merge duplicates → AI score vs CV → D1 "seen" table → Telegram
```

## One-time setup

### 1. Create a Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts. Copy the **bot token**.
2. Send any message (e.g. "hi") to your new bot.
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and find
   `"chat":{"id": 123456789 ...}`. That number is your **chat id**.

### 2. Cloudflare account
Sign up free at https://dash.cloudflare.com/sign-up (email only), then:

```bash
npx wrangler login
```

### 3. Create the database
```bash
npx wrangler d1 create job-scraper
```
Copy the printed `database_id` into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`. Then:

```bash
npm run db:init
```

### 4. Add secrets
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RUN_KEY        # any random string, used for manual test runs
```

### 5. Set what you're looking for
Edit `vars` in `wrangler.jsonc` (all comma-separated):

| Variable | Example | Meaning |
|---|---|---|
| `INCLUDE_KEYWORDS` | `IT, software, network` | Notify only if the job title contains one (whole word; short ALL-CAPS like `IT` are case-sensitive). Empty = all jobs. Not applied to LinkedIn. |
| `EXCLUDE_KEYWORDS` | `senior, intern` | Skip if the title contains any. |
| `MYJOBMAG_QUERIES` | `software developer` | Optional extra MyJobMag searches. The latest 100 jobs always come from MyJobMag's feed. |
| `LINKEDIN_KEYWORDS` | `software engineer, backend` | LinkedIn searches. Empty = LinkedIn off. |
| `LINKEDIN_LOCATION` | `Kenya` / `Nairobi` / `Remote` | LinkedIn location filter. |
| `LINKEDIN_EVERY_MINUTES` | `2` | Run the next LinkedIn search every N minutes (searches rotate). |

Keep searches to ~10 total — the free plan allows 50 outbound requests per run.

### 6. Deploy
```bash
npm run deploy
```

Test immediately (instead of waiting for the cron):
```
https://job-scraper.<your-subdomain>.workers.dev/run?key=<RUN_KEY>
```
The first run for each site only **records** current jobs (so you don't get 30 messages at once).
From then on, only new postings are sent.

Watch live logs: `npm run logs`

## Notes
- **LinkedIn** is used logged-out via its public job search. It rate-limits hard (HTTP 429);
  when that happens the run logs a warning and tries again next time. MyJobMag is unaffected.
- After changing `wrangler.jsonc`, run `npm run deploy` again.
- Reset history: `npx wrangler d1 execute job-scraper --remote --command "DELETE FROM seen_jobs"`

## AI scoring against your CV
Every new job (after `EXCLUDE_KEYWORDS`) is rated 1-10 against the profile in `src/profile.ts`
by Workers AI (`@cf/google/gemma-4-26b-a4b-it`, free allowance, no card). Jobs at or above
`MIN_SCORE` (default 6) are sent with the score and a one-line reason.

- Up to 8 jobs are scored per run; extras wait a minute. `AI_DAILY_LIMIT` (default 600/day) caps usage;
  past it, or if the AI errors, the title keywords decide instead.
- Telegram: `/minscore 7`, `/ai off` / `/ai on`. `/status` shows today’s usage.
- Your profile lives in `src/profile.ts`, which is git-ignored so your work history stays private.
  On a fresh clone: `cp src/profile.example.ts src/profile.ts`, fill it in, then `npm run deploy`.
- Calibrate: `/score-test?key=<RUN_KEY>&title=Network%20Engineer&company=Safaricom` (or `&source=linkedin&n=10` to score stored jobs).
- Upgrading an older database: `npx wrangler d1 execute job-scraper --remote --file=migrations/003_ai_score.sql`

## Telegram commands & buttons
Each alert has **⭐ Save**, **👎 Not interested** (collapses it, with Undo) and **Open job** buttons.

| Command | What it does |
|---|---|
| `/status` | Last check, errors, alerts today |
| `/keywords` | Show title keywords and exclusions |
| `/add a, b` · `/remove a` | Edit title keywords (job boards, not LinkedIn) |
| `/exclude a` · `/unexclude a` | Skip titles containing these words |
| `/resetkeywords` | Back to the lists in `wrangler.jsonc` |
| `/minscore 7` · `/ai on|off` | AI alert threshold / switch scoring |
| `/saved` | Jobs you starred |
| `/pause` · `/resume` | Stop / restart alerts |

Changes made from Telegram are stored in the `settings` table and override `wrangler.jsonc`.

Setup (once, after deploying): `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET` (any random string), then open
`https://job-scraper.<subdomain>.workers.dev/setup?key=<RUN_KEY>` to register the webhook and command menu.
Upgrading an older database: `npx wrangler d1 execute job-scraper --remote --file=migrations/002_bot.sql`

## Duplicates across boards
Each job gets a fingerprint (normalised title + company, see `src/dedupe.ts`). If the same job
appears on several boards — or was already sent from another one — you only get it once.

Upgrading a database created before this feature: `npx wrangler d1 execute job-scraper --remote --file=migrations/001_fingerprint.sql`

## Adding another site
Create `src/sources/<site>.ts` exporting a function that returns `Job[]`, then add it to
the task list in `src/index.ts`.
