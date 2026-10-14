import { cleanText, type Job, USER_AGENT } from "../types";

// Kenya edition. Same markup as the other country sites (myjobmag.com is Nigeria).
const BASE = "https://www.myjobmag.co.ke";

export async function fetchMyJobMag(query?: string): Promise<Job[]> {
  const url = query
    ? `${BASE}/search/jobs?q=${encodeURIComponent(query)}`
    : `${BASE}/jobs`;

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`MyJobMag ${url} -> HTTP ${res.status}`);
  return parseMyJobMag(await res.text());
}

export function parseMyJobMag(html: string): Job[] {
  const jobs: Job[] = [];
  // Each listing is a <li class="job-list-li"> block.
  const blocks = html.split('<li class="job-list-li"').slice(1);

  for (const block of blocks) {
    const link = block.match(/<h2>\s*<a[^>]*href="(\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue; // ads / pagination rows

    const slug = link[1];
    const heading = cleanText(link[2]);
    // Headings look like "Role Title at Company Name".
    const at = heading.lastIndexOf(" at ");
    const title = at > 0 ? heading.slice(0, at) : heading;
    const company = at > 0 ? heading.slice(at + 4) : undefined;

    const desc = block.match(/<li class="job-desc">([\s\S]*?)<\/li>/);
    const date = block.match(/<li id="job-date">([\s\S]*?)<\/li>/);

    jobs.push({
      id: `myjobmag-ke:${slug.replace("/job/", "")}`,
      source: "myjobmag-ke",
      title,
      company,
      description: desc ? cleanText(desc[1]) : undefined,
      posted: date ? cleanText(date[1]) : undefined,
      url: BASE + slug,
    });
  }
  return jobs;
}
