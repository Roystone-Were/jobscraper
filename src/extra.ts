import { scoreJob, scoreScholarship } from "./ai";
import { fetchDetails, isPdfAdvert, pdfExcerpt } from "./details";
import { EXTRA_PROFILES } from "./profile";
import { csgBand, verifiedAiSalary } from "./salary";
import { isScholarship, SCHOLARSHIP_SOURCES, withDeadline, worthScoring } from "./scholarships";
import { keywordRegex } from "./settings";
import { escape, formatJob } from "./telegram";
import type { ExtraProfile, Job } from "./types";

/**
 * Requests per run for all EXTRA_PROFILES together, part of the request
 * budget in index.ts: one per job scored, two per scholarship (its page, then
 * the AI). Anything over the cap is picked up by a later run.
 */
export const EXTRA_REQUESTS_PER_RUN = 3;

/** Earlier jobs (seen_jobs, title and employer only) are checked back this far. */
const LOOKBACK_MS = 14 * 86_400_000;

/** Unsent matches older than this are dropped rather than sent late. */
const PENDING_TTL_MS = 3 * 86_400_000;

export interface PendingAlert {
  profile: string;
  id: string;
  message: string;
  url: string;
}

/**
 * Scores jobs that mention a profile's keywords against that profile, once
 * each, and stores the result; matches keep their Telegram message until
 * sent (see pendingAlerts). `fresh` are this run's new jobs with their full
 * text; jobs from earlier runs come from seen_jobs. Must run before the main
 * profile's pay estimate is filled in, so `salary` is still only ad-stated pay.
 * `scholarships` are every scholarship post fetched this run, seen before or
 * not, so ones over the cap are tried again when their feed comes round.
 * Returns the number of AI calls made.
 */
export async function scoreExtraProfiles(
  db: D1Database,
  ai: Ai,
  fresh: Job[],
  scholarships: Job[],
  minScore: number,
  now: number,
  aiLeft: number,
  errors: string[],
): Promise<number> {
  let calls = 0;
  let requests = 0;
  const left = () => Math.min(EXTRA_REQUESTS_PER_RUN - requests, aiLeft - calls);
  // A different profile goes first each 10-minute slot, so one with a
  // backlog doesn't take every run's few requests.
  const first = Math.floor(now / 600_000) % Math.max(EXTRA_PROFILES.length, 1);
  for (const p of [...EXTRA_PROFILES.slice(first), ...EXTRA_PROFILES.slice(0, first)]) {
    if (left() <= 0) break;
    // No keywords: scholarships only.
    if (p.keywords.length) {
      const keywords = p.keywords.map(keywordRegex);
      const mentions = (s: string) => keywords.some((k) => k.test(s));

      // A PDF advert whose text hasn't been read yet waits for the run that reads it.
      const recent = fresh.filter(
        (j) => !isScholarship(j) && !(isPdfAdvert(j) && !j.pdfText) && mentions(`${j.title} ${j.company ?? ""} ${j.description ?? ""} ${j.pdfText ?? ""}`),
      );
      const earlier = (await earlierJobs(db, p, now)).filter((j) => mentions(`${j.title} ${j.company ?? ""}`));
      const done = await alreadyScored(db, p.key, [...recent, ...earlier]);

      const queue: Job[] = [];
      const taken = new Set<string>();
      for (const j of [...recent, ...earlier]) {
        const fp = j.fingerprint ?? undefined;
        if (done.has(j.id) || (fp && done.has(fp)) || taken.has(j.id) || (fp && taken.has(fp))) continue;
        taken.add(j.id);
        if (fp) taken.add(fp);
        queue.push(j);
      }

      for (const j of queue) {
        if (left() <= 0) break;
        requests++;
        calls++;
        try {
          await scoreFor(db, ai, p, j, p.minScore ?? minScore, now);
        } catch (e) {
          // Not recorded, so it is tried again on a later run.
          errors.push(`${p.key}: ${e}`);
        }
      }
    }

    if (!p.scholarships) continue;
    // Closing soonest first; posts without a date last.
    const posts = scholarships.map(withDeadline).filter((j) => worthScoring(j, now));
    const scored = await alreadyScored(db, p.key, posts);
    const todo = posts
      .filter((j) => !scored.has(j.id))
      .sort((a, b) => (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity));
    for (const post of todo) {
      if (left() < 2) break;
      requests += 2;
      calls++;
      try {
        await scoreScholarshipFor(db, ai, p, post, p.minScore ?? minScore, now);
      } catch (e) {
        errors.push(`${p.key} scholarship: ${e}`);
      }
    }
  }
  return calls;
}

async function scoreScholarshipFor(db: D1Database, ai: Ai, p: ExtraProfile, original: Job, minScore: number, now: number): Promise<void> {
  const post: Job = { ...original };
  // The feed has only the opening lines; eligibility and funding are on the page.
  post.details = (await fetchDetails(post)).text;
  const s = await scoreScholarship(ai, post, p);
  Object.assign(post, { score: s.score, scoreReason: s.reason, strengths: s.strengths, gaps: s.gaps });
  const message = s.score >= minScore ? `<b>${escape(p.label)}</b> · 🎓 Scholarship\n${formatJob(post)}` : null;
  await record(db, p, post, s.score, now, message);
}

async function scoreFor(db: D1Database, ai: Ai, p: ExtraProfile, original: Job, minScore: number, now: number): Promise<void> {
  // A copy: the main profile's run still uses the original's text and fields.
  const job: Job = { ...original };
  if (job.pdfText) job.details = pdfExcerpt(job.pdfText, p.keywords.map(keywordRegex));
  const s = await scoreJob(ai, job, !!job.details, p);
  const text = `${job.title} ${job.description ?? ""} ${job.details ?? ""}`;
  Object.assign(job, {
    score: s.score,
    scoreReason: s.reason,
    strengths: s.strengths,
    gaps: s.gaps,
    salary: job.salary ?? verifiedAiSalary(s.salary, text) ?? csgBand(text, isPdfAdvert(job)) ?? s.estimate,
  });
  const open = !(job.deadlineAt && job.deadlineAt < now);
  const message = s.score >= minScore && open ? `<b>${escape(p.label)}</b>\n${formatJob(job)}` : null;
  await record(db, p, job, s.score, now, message);
}

/** Stores a score for the profile; `message` is the alert still to send, or null. */
async function record(db: D1Database, p: ExtraProfile, job: Job, score: number, now: number, message: string | null): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO profile_alerts (profile, id, fingerprint, score, scored_at, message, url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(p.key, job.id, job.fingerprint ?? null, score, now, message, job.url)
    .run();
}

/** Jobs from earlier runs whose title or employer may mention the profile's keywords, not yet scored for it. */
async function earlierJobs(db: D1Database, p: ExtraProfile, now: number): Promise<Job[]> {
  // LIKE narrows it down (case-insensitive substrings); the caller then
  // applies the whole-word keyword match.
  const likes = p.keywords.map(() => "title LIKE ? OR company LIKE ?").join(" OR ");
  const { results } = await db
    .prepare(
      `SELECT id, source, title, company, url, fingerprint FROM seen_jobs
       WHERE first_seen >= ? AND (${likes})
         AND source NOT IN (${SCHOLARSHIP_SOURCES.map(() => "?").join(",")})
         AND id NOT IN (SELECT id FROM profile_alerts WHERE profile = ?)
       ORDER BY first_seen DESC LIMIT 50`,
    )
    .bind(now - LOOKBACK_MS, ...p.keywords.flatMap((k) => [`%${k}%`, `%${k}%`]), ...SCHOLARSHIP_SOURCES, p.key)
    .all<{ id: string; source: Job["source"]; title: string; company: string | null; url: string; fingerprint: string | null }>();
  return results.map((r) => ({ ...r, company: r.company ?? undefined }));
}

/** Ids and fingerprints among `jobs` already scored for the profile. */
async function alreadyScored(db: D1Database, profile: string, jobs: Job[]): Promise<Set<string>> {
  const found = new Set<string>();
  const keys = [...new Set(jobs.flatMap((j) => (j.fingerprint ? [j.id, j.fingerprint] : [j.id])))];
  // D1 caps bound parameters per query, so look keys up in chunks.
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT id, fingerprint FROM profile_alerts WHERE profile = ? AND (id IN (${marks}) OR fingerprint IN (${marks}))`)
      .bind(profile, ...chunk, ...chunk)
      .all<{ id: string; fingerprint: string | null }>();
    for (const r of results) {
      found.add(r.id);
      if (r.fingerprint) found.add(r.fingerprint);
    }
  }
  return found;
}

/** Matches not yet sent, oldest first. */
export async function pendingAlerts(db: D1Database, now: number, limit: number): Promise<PendingAlert[]> {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      "SELECT profile, id, message, url FROM profile_alerts WHERE message IS NOT NULL AND notified_at IS NULL AND scored_at >= ? ORDER BY scored_at LIMIT ?",
    )
    .bind(now - PENDING_TTL_MS, limit)
    .all<PendingAlert>();
  return results;
}

export async function markAlertSent(db: D1Database, alert: PendingAlert, now: number): Promise<void> {
  await db.prepare("UPDATE profile_alerts SET notified_at = ? WHERE profile = ? AND id = ?").bind(now, alert.profile, alert.id).run();
}
