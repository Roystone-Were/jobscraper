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
