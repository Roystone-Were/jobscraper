import { scoreJob } from "./ai";
import { isPdfAdvert, pdfExcerpt } from "./details";
import { EXTRA_PROFILES } from "./profile";
import { csgBand, verifiedAiSalary } from "./salary";
import { keywordRegex } from "./settings";
import { escape, formatJob } from "./telegram";
import type { ExtraProfile, Job } from "./types";

/**
 * AI scorings per run for all EXTRA_PROFILES together, part of the request
 * budget in index.ts. Jobs over the cap are picked up by a later run.
 */
export const EXTRA_AI_PER_RUN = 3;

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
 * Returns the number of AI calls made.
 */
export async function scoreExtraProfiles(
  db: D1Database,
  ai: Ai,
  fresh: Job[],
  minScore: number,
  now: number,
  aiLeft: number,
  errors: string[],
): Promise<number> {
  let calls = 0;
  for (const p of EXTRA_PROFILES) {
    const left = Math.min(EXTRA_AI_PER_RUN, aiLeft) - calls;
    if (left <= 0) break;
    const keywords = p.keywords.map(keywordRegex);
    const mentions = (s: string) => keywords.some((k) => k.test(s));

    // A PDF advert whose text hasn't been read yet waits for the run that reads it.
    const recent = fresh.filter(
      (j) => !(isPdfAdvert(j) && !j.pdfText) && mentions(`${j.title} ${j.company ?? ""} ${j.description ?? ""} ${j.pdfText ?? ""}`),
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

    for (const j of queue.slice(0, left)) {
      calls++;
      try {
        await scoreFor(db, ai, p, j, p.minScore ?? minScore, now);
      } catch (e) {
        // Not recorded, so it is tried again on a later run.
        errors.push(`${p.key}: ${e}`);
      }
    }
  }
  return calls;
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
  await db
    .prepare(
      "INSERT OR IGNORE INTO profile_alerts (profile, id, fingerprint, score, scored_at, message, url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(p.key, job.id, job.fingerprint ?? null, s.score, now, message, job.url)
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
         AND id NOT IN (SELECT id FROM profile_alerts WHERE profile = ?)
       ORDER BY first_seen DESC LIMIT 50`,
    )
    .bind(now - LOOKBACK_MS, ...p.keywords.flatMap((k) => [`%${k}%`, `%${k}%`]), p.key)
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
