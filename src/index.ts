import { scoreJob } from "./ai";
import { COMMANDS, handleUpdate } from "./bot";
import { fingerprint, shortKey } from "./dedupe";
import { getSetting, loadSettings, setSetting } from "./settings";
import { fetchBrighterMonday } from "./sources/brightermonday";
import { fetchLinkedIn } from "./sources/linkedin";
import { fetchMyJobMag } from "./sources/myjobmag";
import { fetchRss, RSS_FEEDS } from "./sources/rss";
import { formatJob, jobKeyboard, sendTelegram, tg } from "./telegram";
import { type Env, type Job, splitList } from "./types";

/**
 * Max Telegram messages per run. Anything over this stays unseen and is sent
 * on the next run, which keeps us under Telegram's rate limits and the Workers
 * free-plan limit of 50 outbound requests per invocation.
 */
const MAX_NOTIFICATIONS_PER_RUN = 20;

/** AI calls per run; the rest wait a minute. Keeps each run well inside request limits. */
const AI_PER_RUN = 8;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env, new Date(controller.scheduledTime)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook: commands and button presses.
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await handleUpdate(env, await request.json());
      } catch (e) {
        // Still answer 200, or Telegram keeps redelivering the same update.
        console.error("telegram update failed", e);
      }
      return new Response("ok");
    }

    const authorized = env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY;

    // GET /run?key=<RUN_KEY> triggers a run by hand (LinkedIn included).
    if (url.pathname === "/run" && authorized) {
      return Response.json(await run(env, new Date(), true));
    }

    // GET /score-test?key=<RUN_KEY>&n=10 scores recent jobs without sending anything.
    if (url.pathname === "/score-test" && authorized) {
      const n = Math.min(10, Number(url.searchParams.get("n")) || 8);
      // &title=...&company=...&location=... scores one made-up ad.
      const title = url.searchParams.get("title");
      if (title) {
        const ad = { id: "", url: "", source: "linkedin" as const, title,
          company: url.searchParams.get("company") ?? undefined, location: url.searchParams.get("location") ?? undefined };
        return Response.json({ title, ...(await scoreJob(env.AI, ad)) });
      }
      // Optional &source=linkedin to sample a specific board.
      const source = url.searchParams.get("source");
      const { results } = await env.DB
        .prepare(`SELECT source, title, company FROM seen_jobs ${source ? "WHERE source = ?" : ""} ORDER BY RANDOM() LIMIT ?`)
        .bind(...(source ? [source, n] : [n]))
        .all<Pick<Job, "source" | "title" | "company">>();
      const scored = await Promise.all(
        results.map(async (j) => {
          try {
            return { ...j, ...(await scoreJob(env.AI, { ...j, id: "", url: "", company: j.company ?? undefined })) };
          } catch (e) {
            return { ...j, error: String(e) };
          }
        }),
      );
      return Response.json(scored);
    }

    // GET /setup?key=<RUN_KEY> points the bot's webhook here and registers the command menu.
    if (url.pathname === "/setup" && authorized) {
      const token = env.TELEGRAM_BOT_TOKEN;
      await tg(token, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      await tg(token, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      return Response.json(await tg(token, "getWebhookInfo", {}));
    }

    return new Response("job-scraper is running", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function run(env: Env, now: Date, forceAll = false) {
  const settings = await loadSettings(env);
  const tasks: { name: string; fetch: () => Promise<Job[]> }[] = [];

  // Order matters: when the same job is on several boards, the first wins.
  for (const feed of RSS_FEEDS) {
    tasks.push({ name: feed.source, fetch: () => fetchRss(feed) });
  }
  for (const q of splitList(env.MYJOBMAG_QUERIES)) {
    tasks.push({ name: `myjobmag:${q}`, fetch: () => fetchMyJobMag(q) });
  }
  tasks.push({ name: "brightermonday", fetch: fetchBrighterMonday });

  // LinkedIn blocks bursts, so run one search every N minutes, rotating
  // through the keyword list. A manual /run fires all of them.
  const liKeywords = splitList(env.LINKEDIN_KEYWORDS);
  const everyMin = Math.max(1, Number(env.LINKEDIN_EVERY_MINUTES) || 2);
  const slot = Math.floor(now.getTime() / 60_000);
  const liDue = forceAll ? liKeywords : slot % everyMin === 0 && liKeywords.length
    ? [liKeywords[(slot / everyMin) % liKeywords.length]]
    : [];
  for (const kw of liDue) {
    tasks.push({ name: `linkedin:${kw}`, fetch: () => fetchLinkedIn(kw, env.LINKEDIN_LOCATION) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.fetch()));
  const errors: string[] = [];
  const byId = new Map<string, Job>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push(`${tasks[i].name}: ${r.reason}`);
      return;
    }
    for (const job of r.value) byId.set(job.id, job);
  });
  errors.forEach((e) => console.warn(e));

  // The same job often appears on several boards; keep the first copy.
  const fetched: Job[] = [];
  const fpInRun = new Set<string>();
  for (const job of byId.values()) {
    job.fingerprint = fingerprint(job);
    if (job.fingerprint && fpInRun.has(job.fingerprint)) continue;
    if (job.fingerprint) fpInRun.add(job.fingerprint);
    fetched.push(job);
  }

  const seen = await seenKeys(env.DB, fetched);
  const unseen = fetched.filter(
    (j) => !seen.ids.has(j.id) && !(j.fingerprint && seen.fingerprints.has(j.fingerprint)),
  );

  // First time a source returns results, record them silently instead of
  // flooding Telegram with every job currently listed.
  const knownSources = await sourcesWithHistory(env.DB);
  const seeding = unseen.filter((j) => !knownSources.has(j.source));
  const candidates = unseen.filter((j) => knownSources.has(j.source));

  const include = settings.include.map(keywordRegex);
  const exclude = settings.exclude.map(keywordRegex);

  // Excluded words always win. While paused, everything is recorded as seen
  // instead of queued, so /resume doesn't unleash a backlog.
  const skipped = candidates.filter((j) => settings.paused || exclude.some((k) => k.test(j.title)));
  // Sites list newest first; handle oldest first so Telegram reads in order.
  let open = candidates.filter((j) => !skipped.includes(j)).reverse();

  // AI scores each job against the CV. Jobs over the per-run or daily budget
  // wait for the next run (per-run) or fall back to keywords (daily).
  let deferred = 0;
  if (settings.aiScoring && env.AI && open.length) {
    const budget = await aiBudgetLeft(env, now);
    if (budget > 0) {
      const batch = open.slice(0, Math.min(AI_PER_RUN, budget));
      deferred = open.length - batch.length;
      open = batch;
      const scores = await Promise.allSettled(batch.map((j) => scoreJob(env.AI, j)));
      scores.forEach((r, i) => {
        if (r.status === "fulfilled") {
          batch[i].score = r.value.score;
          batch[i].scoreReason = r.value.reason;
        } else {
          errors.push(`ai: ${r.reason}`);
        }
      });
      await recordAiUsage(env, now, batch.length);
    }
  }

  // Scored jobs need the minimum score; unscored ones use the keyword lists.
  const isMatch = (j: Job) => (j.score != null ? j.score >= settings.minScore : matches(j, include, []));
  const matched = open.filter(isMatch);
  const unmatched = [...skipped, ...open.filter((j) => !isMatch(j))];

  const toSend = matched.slice(0, MAX_NOTIFICATIONS_PER_RUN);
  const sent: Job[] = [];
  for (const job of toSend) {
    try {
      job.shortKey = shortKey(job.id);
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, formatJob(job), jobKeyboard(job.shortKey, job.url));
      job.notifiedAt = Date.now();
      sent.push(job);
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      // Unsent jobs stay unseen and are retried next run.
      errors.push(String(e));
      console.error(e);
      break;
    }
  }

  await markSeen(env.DB, [...seeding, ...unmatched, ...sent], now.getTime());

  const summary = {
    fetched: fetched.length,
    new: unseen.length,
    seeded: seeding.length,
    notified: sent.length,
    scored: open.filter((j) => j.score != null).length,
    pending: matched.length - sent.length + deferred,
    errors,
  };
  console.log(JSON.stringify(summary));
  await setSetting(env.DB, "last_run", JSON.stringify({ at: now.getTime(), fetched: fetched.length, errors }));
  return summary;
}

/**
 * Whole-word match. Short all-caps keywords ("IT", "ICT") are case-sensitive
 * so "IT Officer" matches but "apply for it" does not.
 */
export function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const caseSensitive = keyword.length <= 3 && keyword === keyword.toUpperCase();
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, caseSensitive ? "" : "i");
}

// Keywords are matched against the title only. LinkedIn results already come
// from targeted searches, so the include list doesn't apply to them.
export function matches(job: Job, include: RegExp[], exclude: RegExp[]): boolean {
  if (exclude.some((k) => k.test(job.title))) return false;
  if (!include.length || job.source === "linkedin") return true;
  return include.some((k) => k.test(job.title));
}

async function seenKeys(db: D1Database, jobs: Job[]) {
  const lookup = async (column: "id" | "fingerprint", values: string[]) => {
    const found = new Set<string>();
    // D1 caps bound parameters per query, so look values up in chunks.
    for (let i = 0; i < values.length; i += 90) {
      const chunk = values.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT ${column} AS v FROM seen_jobs WHERE ${column} IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ v: string }>();
      for (const row of results) found.add(row.v);
    }
    return found;
  };
  const [ids, fingerprints] = await Promise.all([
    lookup("id", jobs.map((j) => j.id)),
    lookup("fingerprint", jobs.flatMap((j) => (j.fingerprint ? [j.fingerprint] : []))),
  ]);
  return { ids, fingerprints };
}

async function sourcesWithHistory(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT source FROM seen_jobs")
    .all<{ source: string }>();
  return new Set(results.map((r) => r.source));
}

async function markSeen(db: D1Database, jobs: Job[], now: number): Promise<void> {
  if (!jobs.length) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO seen_jobs (id, source, title, company, url, first_seen, fingerprint, short_key, notified_at, score, score_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(
    jobs.map((j) =>
      stmt.bind(j.id, j.source, j.title, j.company ?? null, j.url, now, j.fingerprint ?? null, j.shortKey ?? null, j.notifiedAt ?? null, j.score ?? null, j.scoreReason ?? null),
    ),
  );
}

const nairobiDay = (d: Date) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

async function aiBudgetLeft(env: Env, now: Date): Promise<number> {
  const limit = Number(env.AI_DAILY_LIMIT) || 600;
  const usage = JSON.parse((await getSetting(env.DB, "ai_usage")) ?? "{}") as { day?: string; n?: number };
  return usage.day === nairobiDay(now) ? Math.max(0, limit - (usage.n ?? 0)) : limit;
}

async function recordAiUsage(env: Env, now: Date, calls: number): Promise<void> {
  const day = nairobiDay(now);
  const usage = JSON.parse((await getSetting(env.DB, "ai_usage")) ?? "{}") as { day?: string; n?: number };
  const n = (usage.day === day ? usage.n ?? 0 : 0) + calls;
  await setSetting(env.DB, "ai_usage", JSON.stringify({ day, n }));
}
