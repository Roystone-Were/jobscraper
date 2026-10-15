import { cleanText, type Job, USER_AGENT } from "../types";

/**
 * LinkedIn's public (logged-out) job search fragment. No account is used.
 * LinkedIn rate-limits aggressively (HTTP 429), so callers should poll slowly
 * and treat failures as "try again later".
 */
export async function fetchLinkedIn(keywords: string, location: string): Promise<Job[]> {
  const params = new URLSearchParams({
    keywords,
    location,
    f_TPR: "r86400", // posted in the last 24h
    sortBy: "DD", // newest first
    start: "0",
  });
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`LinkedIn "${keywords}" -> HTTP ${res.status}`);
  return parseLinkedIn(await res.text());
}

export function parseLinkedIn(html: string): Job[] {
  const jobs: Job[] = [];
  const blocks = html.split("<li").slice(1);

  for (const block of blocks) {
    const urn = block.match(/urn:li:jobPosting:(\d+)/);
    const title = block.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/);
    if (!urn || !title) continue;

    const company = block.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/);
    const location = block.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/);
    const posted = block.match(/<time[^>]*>([\s\S]*?)<\/time>/);

    jobs.push({
      id: `linkedin:${urn[1]}`,
      source: "linkedin",
      title: cleanText(title[1]),
      company: company ? cleanText(company[1]) : undefined,
      location: location ? cleanText(location[1]) : undefined,
      posted: posted ? cleanText(posted[1]) : undefined,
      url: `https://www.linkedin.com/jobs/view/${urn[1]}/`,
    });
  }
  return jobs;
}

/** Inbox rows older than this are dropped (LinkedIn searches cover the last 24 h). */
const INBOX_TTL_MS = 3 * 24 * 3600_000;

/** Queues jobs parsed from a search page the PC fetched. Returns how many were parsed. */
export async function queueLinkedIn(db: D1Database, html: string, now: number): Promise<number> {
  const jobs = parseLinkedIn(html);
  if (jobs.length) {
    const insert = db.prepare("INSERT OR IGNORE INTO linkedin_inbox (id, job, added) VALUES (?, ?, ?)");
    await db.batch(jobs.map((j) => insert.bind(j.id, JSON.stringify(j), now)));
  }
  return jobs.length;
}

/**
 * Jobs waiting in the inbox. Like a site feed, they keep coming back until a
 * run records them as seen (so jobs deferred by the AI or Telegram caps are
 * not lost); seen and stale rows are cleared here.
 */
export async function readLinkedInInbox(db: D1Database, now: number): Promise<Job[]> {
  await db
    .prepare("DELETE FROM linkedin_inbox WHERE added < ? OR id IN (SELECT id FROM seen_jobs)")
    .bind(now - INBOX_TTL_MS)
    .run();
  // Newest first, like the sites (rowid keeps LinkedIn's order within a push).
  const { results } = await db.prepare("SELECT job FROM linkedin_inbox ORDER BY added DESC, rowid").all<{ job: string }>();
  return results.map((r) => JSON.parse(r.job) as Job);
}
