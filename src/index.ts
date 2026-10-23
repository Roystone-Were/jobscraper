import { scoreJob } from "./ai";
import { COMMANDS, handleUpdate } from "./bot";
import { fingerprint, shortKey } from "./dedupe";
import { fetchDetails, fetchPdfText, hasDetailPage, isPdfAdvert, pdfExcerpt } from "./details";
import { csgBand, verifiedAiSalary } from "./salary";
import { buildDaily, buildEvening, recordHealth, sendWeeklyDigest, sourceOfTask } from "./digest";
import { getSetting, keywordRegex, loadSettings, setSetting } from "./settings";
import { fetchBrighterMonday } from "./sources/brightermonday";
import { fetchCorporateStaffing } from "./sources/corporatestaffing";
import { fetchImpactpool } from "./sources/impactpool";
import { EMPLOYERS, fetchEmployer } from "./sources/employers";
import { fetchTelegram, TELEGRAM_CHANNELS } from "./sources/telegram";
// Kenyajob (fetchKenyajob) parses fine but returns 403 to Cloudflare's IPs.
import { ETALENT_BOARDS, FUZU_PAGES, fetchEtalent, fetchFuzu, fetchGaa, fetchIcta, fetchJkuat, fetchMeru, fetchNakuru, fetchNyamira, fetchPsc } from "./sources/boards";
import { fetchFreehire } from "./sources/freehire";
import { fetchHimalayas, fetchJobicy, fetchWwr } from "./sources/remote";
import { fetchReliefWeb, RELIEFWEB_FILTERS } from "./sources/reliefweb";
import { fetchUnTalent } from "./sources/untalent";
import { fetchLinkedIn, queueLinkedIn, readLinkedInInbox } from "./sources/linkedin";
import { fetchMyJobMag } from "./sources/myjobmag";
import { COUNTY_FEEDS, fetchRss, KIAMBU_FEED, RSS_FEEDS } from "./sources/rss";
import { markAlertSent, pendingAlerts, scoreExtraProfiles } from "./extra";
import { EXTRA_PROFILES } from "./profile";
import { isScholarship, isScholarshipId, SCHOLARSHIP_FEEDS } from "./scholarships";
import { formatJob, jobKeyboard, openKeyboard, sendTelegram, tg } from "./telegram";
import { type Env, type Job, splitList } from "./types";

/**
 * Max Telegram messages per run. Anything over this stays unseen and is sent
 * on the next run, which keeps us under Telegram's rate limits and the Workers
 * free-plan limit of 50 outbound requests per invocation.
 */
const MAX_NOTIFICATIONS_PER_RUN = 10;

/**
 * Per-run caps (see SECONDARY_PER_RUN for the full request budget).
 * Anything over a cap waits for the next run.
 */
const AI_PER_RUN = 12;
const DETAIL_PER_RUN = 5;
/**
 * PDF adverts read per run. Each costs up to 3 requests (viewer page, PDF,
 * conversion) and takes 2 of the DETAIL_PER_RUN slots, so job pages plus
 * second looks plus PDFs stay within the 10 requests budgeted for them.
 */
const PDF_PER_RUN = 2;
/** Alerts for EXTRA_PROFILES per run, sent first and counted in MAX_NOTIFICATIONS_PER_RUN. */
const EXTRA_SENDS_PER_RUN = 5;

/**
 * Lower-volume sources take turns: this many per run, rotating, so the request
 * budget stays fixed as the list grows. Budget per run: main sites (7) +
 * rotating (6) + LinkedIn (2) + AI (12) + job pages (5) + second AI look (5)
 * + other profiles (EXTRA_REQUESTS_PER_RUN, 3) + Telegram sends (10) = 50 of
 * the free plan's 50. LinkedIn is pushed from a PC (LINKEDIN_PER_RUN=0), so
 * in practice it is 48.
 */
const SECONDARY_PER_RUN = 6;
const SECONDARY: { name: string; fetch: (env: Env) => Promise<Job[]> }[] = [
  { name: "fuzu:latest", fetch: () => fetchFuzu(FUZU_PAGES.latest) },
  { name: "psc", fetch: fetchPsc },
  ...TELEGRAM_CHANNELS.map((c) => ({ name: `telegram:${c}`, fetch: () => fetchTelegram(c) })),
  { name: "fuzu:it", fetch: () => fetchFuzu(FUZU_PAGES.it) },
  { name: "icta", fetch: fetchIcta },
  { name: "nakuru", fetch: fetchNakuru },
  { name: "kiambu", fetch: () => fetchRss(KIAMBU_FEED) },
  { name: "gaa", fetch: fetchGaa },
  { name: "nyamira", fetch: fetchNyamira },
  { name: "meru", fetch: fetchMeru },
  { name: "jkuat", fetch: fetchJkuat },
  { name: "reliefweb:ict", fetch: (env) => fetchReliefWeb(env.RELIEFWEB_APPNAME, RELIEFWEB_FILTERS.ict) },
  { name: "reliefweb:agriculture", fetch: (env) => fetchReliefWeb(env.RELIEFWEB_APPNAME, RELIEFWEB_FILTERS.agriculture) },
  { name: "freehire", fetch: fetchFreehire },
  { name: "himalayas", fetch: fetchHimalayas },
  // Two feeds, so two requests: still within the budget above (49 of 50).
  { name: "wwr", fetch: fetchWwr },
  { name: "jobicy", fetch: fetchJobicy },
  ...COUNTY_FEEDS.map((f) => ({ name: f.source, fetch: () => fetchRss(f) })),
  ...EMPLOYERS.map((e) => ({ name: `employer:${e.slug}`, fetch: () => fetchEmployer(e) })),
  ...ETALENT_BOARDS.map((b) => ({ name: `etalent:${b.slug}`, fetch: () => fetchEtalent(b) })),
  // Only fetched when someone in EXTRA_PROFILES wants scholarships.
  ...(EXTRA_PROFILES.some((p) => p.scholarships) ? SCHOLARSHIP_FEEDS.map((f) => ({ name: f.name, fetch: () => fetchRss(f) })) : []),
];

/** LINKEDIN_KEYWORDS_ROTATING searches added to each PC push (see GET /linkedin). */
const LINKEDIN_ROTATING_PER_PUSH = 4;

/** Mondays 08:00 Nairobi (05:00 UTC). Must match the second cron in wrangler.jsonc. */
export const DIGEST_CRON = "0 5 * * 1";
/** Daily 07:00 Nairobi (04:00 UTC) round-up. Must match wrangler.jsonc. */
export const DAILY_CRON = "0 4 * * *";
/** Daily 18:00 Nairobi (15:00 UTC) near-miss list. Must match wrangler.jsonc. */
export const EVENING_CRON = "0 15 * * *";

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron === DIGEST_CRON) {
      ctx.waitUntil(
        sendWeeklyDigest(env, (html) => sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, html)),
      );
      return;
    }
    if (controller.cron === DAILY_CRON) {
      ctx.waitUntil(
        loadSettings(env).then(async (s) =>
          sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, await buildDaily(env, s.minScore)),
        ),
      );
      return;
    }
    if (controller.cron === EVENING_CRON) {
      ctx.waitUntil(
        loadSettings(env).then(async (s) => {
          const html = await buildEvening(env, s.minScore);
          if (html) await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, html);
        }),
      );
      return;
    }
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

    // LinkedIn blocks Cloudflare's IPs, so a PC fetches the searches (pc/linkedin-push.ps1).
    // GET returns the searches to run; POST &keyword=... sends one results page as HTML.
    if (url.pathname === "/linkedin") {
      if (!env.LINKEDIN_PUSH_KEY || url.searchParams.get("key") !== env.LINKEDIN_PUSH_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method === "POST") {
        const now = Date.now();
        const keyword = url.searchParams.get("keyword") ?? "";
        const parsed = await queueLinkedIn(env.DB, await request.text(), now);
        await recordHealth(env.DB, now, [{ source: "linkedin", jobs: parsed }]);
        return Response.json({ keyword, parsed });
      }
      // Every push runs all of LINKEDIN_KEYWORDS, then the next few rotating
      // ones (by half hour), so pushes stay short and the extras are each
      // searched about hourly. The PC stops at a block, so the extras go last.
      const rotating = splitList(env.LINKEDIN_KEYWORDS_ROTATING);
      const perPush = Math.min(LINKEDIN_ROTATING_PER_PUSH, rotating.length);
      const halfHour = Math.floor(Date.now() / 1_800_000);
      const extra = Array.from({ length: perPush }, (_, i) => rotating[(halfHour * perPush + i) % rotating.length]);
      return Response.json({ keywords: [...new Set([...splitList(env.LINKEDIN_KEYWORDS), ...extra])], location: env.LINKEDIN_LOCATION });
    }

    const authorized = env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY;

    // GET /run?key=<RUN_KEY> triggers a run by hand with every LinkedIn search;
    // add &linkedin=0 to skip LinkedIn (it rate-limits bursts).
    if (url.pathname === "/run" && authorized) {
      // &secondary=all fetches every rotating source this run; &secondary=<name>
      // (e.g. etalent:peoplefoco) fetches just that one.
      return Response.json(
        await run(env, new Date(), url.searchParams.get("linkedin") !== "0", url.searchParams.get("linkedin") === "0", url.searchParams.get("secondary") ?? undefined),
      );
    }

    // GET /score-test?key=<RUN_KEY>&n=10 scores recent jobs without sending anything.
    if (url.pathname === "/score-test" && authorized) {
      const n = Math.min(10, Number(url.searchParams.get("n")) || 8);
      // &id=<stored job id> scores it on the feed summary, then on the full job page.
      const id = url.searchParams.get("id");
      if (id) {
        const row = await env.DB.prepare("SELECT id, source, title, company, url FROM seen_jobs WHERE id = ?")
          .bind(id).first<Pick<Job, "id" | "source" | "title" | "url"> & { company: string | null }>();
        if (!row) return Response.json({ error: "not found" }, { status: 404 });
        const job: Job = { ...row, company: row.company ?? undefined };
        const before = await scoreJob(env.AI, job);
        if (!hasDetailPage(job)) return Response.json({ title: job.title, before, note: "no job page for this source" });
        const d = await fetchDetails(job).catch((e) => ({ error: String(e) }) as const);
        if ("error" in d) return Response.json({ title: job.title, before, error: d.error });
        Object.assign(job, { details: d.text, deadline: d.deadline });
        const after = job.details ? await scoreJob(env.AI, job, true) : null;
        const closed = d.deadlineAt != null && d.deadlineAt < Date.now();
        return Response.json({ title: job.title, before, after, deadline: d.deadline, closed, detailChars: d.text?.length ?? 0 });
      }
      // &title=...&company=...&location=...&details=... scores one ad.
      const title = url.searchParams.get("title");
      if (title) {
        const ad = { id: "", url: "", source: "linkedin" as const, title,
          company: url.searchParams.get("company") ?? undefined, location: url.searchParams.get("location") ?? undefined,
          description: url.searchParams.get("details") ?? undefined };
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

async function run(env: Env, now: Date, forceAll = false, skipLinkedIn = false, secondary?: string) {
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
  tasks.push({ name: "corporatestaffing", fetch: fetchCorporateStaffing });
  tasks.push({ name: "untalent", fetch: fetchUnTalent });
  tasks.push({ name: "impactpool", fetch: fetchImpactpool });

  const tenMin = Math.floor(now.getTime() / 600_000);
  if (secondary && secondary !== "all") {
    for (const s of SECONDARY.filter((s) => s.name === secondary)) tasks.push({ name: s.name, fetch: () => s.fetch(env) });
  } else {
    const take = secondary === "all" ? SECONDARY.length : Math.min(SECONDARY_PER_RUN, SECONDARY.length);
    for (let i = 0; i < take; i++) {
      const s = SECONDARY[(tenMin * take + i) % SECONDARY.length];
      tasks.push({ name: s.name, fetch: () => s.fetch(env) });
    }
  }

  // LinkedIn blocks bursts, so each run takes the next few searches from the
  // keyword list (rotating by 10-minute slot), a few seconds apart.
  // A manual /run fires all of them. LINKEDIN_PER_RUN=0 turns this off when a
  // PC pushes LinkedIn results instead (read from the inbox below).
  const perRun = Math.max(0, Number(env.LINKEDIN_PER_RUN ?? 2) || 0);
  const liKeywords = skipLinkedIn || perRun === 0 ? [] : splitList(env.LINKEDIN_KEYWORDS);
  const slot = tenMin;
  const liDue = forceAll
    ? liKeywords
    : liKeywords.length
      ? [...new Set(Array.from({ length: Math.min(perRun, liKeywords.length) }, (_, i) => liKeywords[(slot * perRun + i) % liKeywords.length]))]
      : [];
  liDue.forEach((kw, i) => {
    tasks.push({
      name: `linkedin:${kw}`,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, i * 4000));
        return fetchLinkedIn(kw, env.LINKEDIN_LOCATION);
      },
    });
  });

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
  // Pushed from the PC; health was recorded when it arrived.
  if (!skipLinkedIn) {
    try {
      for (const job of await readLinkedInInbox(env.DB, now.getTime())) if (!byId.has(job.id)) byId.set(job.id, job);
    } catch (e) {
      errors.push(`linkedin:inbox: ${e}`);
    }
  }
  errors.forEach((e) => console.warn(e));
  await recordHealth(
    env.DB,
    now.getTime(),
    results.map((r, i) => ({
      source: sourceOfTask(tasks[i].name),
      ...(r.status === "fulfilled" ? { jobs: r.value.length } : { error: String(r.reason) }),
    })),
  );

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
  const isNew = (j: Job) => !seen.ids.has(j.id) && !(j.fingerprint && seen.fingerprints.has(j.fingerprint));
  // Scholarship posts are only for EXTRA_PROFILES: recorded as seen, never
  // scored for you. All of this run's go to them, new or not (see extra.ts).
  const scholarships = fetched.filter(isScholarship);
  const newPosts = scholarships.filter(isNew);
  const unseen = fetched.filter((j) => isNew(j) && !isScholarship(j));

  // First time a source returns results: with AI scoring on, its current jobs
  // are scored like any others (only good matches are sent, so no flood). With
  // AI off, they are recorded silently instead of alerting on every listing.
  const knownSources = await sourcesWithHistory(env.DB);
  const seeding = settings.aiScoring ? [] : unseen.filter((j) => !knownSources.has(j.source));
  const candidates = unseen.filter((j) => !seeding.includes(j));

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
  let secondLooks = 0;
  if (settings.aiScoring && env.AI && open.length) {
    const budget = await aiBudgetLeft(env, now);
    if (budget > 0) {
      // PDF adverts over this run's allowance wait, unseen, for a later run.
      let pdfSlots = PDF_PER_RUN;
      const ready = open.filter((j) => !isPdfAdvert(j) || pdfSlots-- > 0);
      const batch = ready.slice(0, Math.min(AI_PER_RUN, budget));
      deferred = open.length - batch.length;
      open = batch;
      // A PDF advert's title says little ("Vacancies at KRA"), so its text is
      // read first and the AI scores that. If reading fails, the title is scored.
      const pdfs = batch.filter(isPdfAdvert);
      const read = await Promise.allSettled(
        pdfs.map(async (j) => {
          j.pdfText = await fetchPdfText(env.AI, j);
          j.details = pdfExcerpt(j.pdfText, include);
        }),
      );
      read.forEach((r) => r.status === "rejected" && errors.push(`pdf: ${r.reason}`));
      const scores = await Promise.allSettled(batch.map((j) => scoreJob(env.AI, j, isPdfAdvert(j) && !!j.details)));
      scores.forEach((r, i) => {
        if (r.status === "fulfilled") {
          batch[i].score = r.value.score;
          batch[i].scoreReason = r.value.reason;
          batch[i].strengths = r.value.strengths;
          batch[i].gaps = r.value.gaps;
          batch[i].salary ??= verifiedAiSalary(r.value.salary, `${batch[i].title} ${batch[i].description ?? ""} ${batch[i].details ?? ""}`);
          batch[i].payEstimate = r.value.estimate;
        } else {
          errors.push(`ai: ${r.reason}`);
        }
      });
      // Second look for anything scoring 3+: the full job text (from the feed
      // if it carried it, otherwise the job page) is scored again, and the
      // page's closing date is checked. Clear no's (1-2) are not worth it.
      // Highest first, so likely alerts are always checked.
      // PDF adverts were already scored on their full text.
      const refine = batch
        .filter((j) => j.score != null && j.score >= 3 && !isPdfAdvert(j) && (j.details || hasDetailPage(j)))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, Math.max(0, DETAIL_PER_RUN - 2 * pdfs.length));
      const refined = await Promise.allSettled(
        refine.map(async (j) => {
          if (!j.details) {
            const d = await fetchDetails(j);
            j.details = d.text;
            j.deadline = d.deadline;
            j.deadlineAt = d.deadlineAt;
            j.salary ??= d.salary;
          }
          if (!j.details) return;
          const s = await scoreJob(env.AI, j, true);
          j.score = s.score;
          j.scoreReason = s.reason;
          j.strengths = s.strengths;
          j.gaps = s.gaps;
          j.salary ??= verifiedAiSalary(s.salary, `${j.title} ${j.details}`);
          j.payEstimate = s.estimate ?? j.payEstimate;
        }),
      );
      refined.forEach((r) => r.status === "rejected" && errors.push(`details: ${r.reason}`));
      secondLooks = refine.length;

      await recordAiUsage(env, now, batch.length + refine.length);
    }
  }

  // Other people's matches (EXTRA_PROFILES). Runs before the pay estimate
  // below fills `salary`, so they only inherit pay the ad states. A failure
  // here must not stop the main alerts.
  let extraScored = 0;
  if (EXTRA_PROFILES.length && settings.aiScoring && env.AI && !settings.paused) {
    try {
      const aiLeft = await aiBudgetLeft(env, now);
      extraScored = await scoreExtraProfiles(env.DB, env.AI, unseen, scholarships, settings.minScore, now.getTime(), aiLeft, errors);
      if (extraScored) await recordAiUsage(env, now, extraScored);
    } catch (e) {
      errors.push(`extra profiles: ${e}`);
    }
  }

  // Scored jobs need the minimum score; unscored ones use the keyword lists.
  // Jobs whose closing date has passed are never sent.
  const isMatch = (j: Job) =>
    !(j.deadlineAt && j.deadlineAt < now.getTime()) &&
    (j.score != null ? j.score >= settings.minScore : matches(j, include, []));
  const matched = open.filter(isMatch);
  const unmatched = [...skipped, ...open.filter((j) => !isMatch(j))];

  // Government ads quoting a CSG grade get the official pay band; anything
  // still without pay falls back to the AI's market estimate.
  for (const j of open) {
    j.salary ??= csgBand(`${j.title} ${j.description ?? ""} ${j.details ?? ""}`, isPdfAdvert(j)) ?? j.payEstimate;
  }

  // Other people's alerts go first (a few at most); any of the main list
  // pushed over the cap stays unseen and is sent next run.
  let extraSent = 0;
  try {
    for (const alert of await pendingAlerts(env.DB, now.getTime(), EXTRA_SENDS_PER_RUN)) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, alert.message, openKeyboard(alert.url, isScholarshipId(alert.id) ? "Open ↗" : undefined));
      await markAlertSent(env.DB, alert, Date.now());
      extraSent++;
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    // Unsent ones stay pending for the next run.
    errors.push(`extra alerts: ${e}`);
  }

  const toSend = matched.slice(0, MAX_NOTIFICATIONS_PER_RUN - extraSent);
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

  await markSeen(env.DB, [...seeding, ...unmatched, ...sent, ...newPosts], now.getTime());

  const summary = {
    fetched: fetched.length,
    new: unseen.length,
    seeded: seeding.length,
    notified: sent.length,
    extraScored,
    extraSent,
    scored: open.filter((j) => j.score != null).length,
    secondLooks,
    closed: open.filter((j) => j.deadlineAt && j.deadlineAt < now.getTime()).length,
    pending: matched.length - sent.length + deferred,
    errors,
  };
  console.log(JSON.stringify(summary));
  await setSetting(env.DB, "last_run", JSON.stringify({ at: now.getTime(), fetched: fetched.length, errors }));
  return summary;
}

export { keywordRegex };

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
    "INSERT OR IGNORE INTO seen_jobs (id, source, title, company, url, first_seen, fingerprint, short_key, notified_at, score, score_reason, salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(
    jobs.map((j) =>
      stmt.bind(j.id, j.source, j.title, j.company ?? null, j.url, now, j.fingerprint ?? null, j.shortKey ?? null, j.notifiedAt ?? null, j.score ?? null, j.scoreReason ?? null, j.salary ?? null),
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
