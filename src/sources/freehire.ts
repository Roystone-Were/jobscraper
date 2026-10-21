import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

// freehire.me collects jobs straight from company hiring systems (Workday,
// Zoho Recruit, Greenhouse, Workable...), many of which the Kenyan boards miss.
// Keyless public API, rate-limited per address. Kenya gets ~25 new jobs a day,
// so the newest 50 cover a full rotation; the usual keyword filter and AI
// scoring decide what's relevant.
const API = "https://freehire.me/api/v1/jobs/search?countries=KE&sort=posted_at&order=desc&posted_within_days=7&limit=50";

interface FreehireJob {
  public_slug?: string;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  work_mode?: string;
  posted_at?: string;
  closed_at?: string | null;
  /** Their reposted-as-new check; true means an old advert dressed up as fresh. */
  reality?: { fake_freshness?: boolean };
}

export async function fetchFreehire(): Promise<Job[]> {
  const res = await fetch(API, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`freehire -> HTTP ${res.status}`);
  const json = (await res.json()) as { data?: FreehireJob[]; meta?: { ignored_params?: unknown[] } };
  // A dropped filter would quietly return jobs from everywhere.
  if (json.meta?.ignored_params?.length) throw new Error(`freehire -> ignored ${JSON.stringify(json.meta.ignored_params)}`);
  return parseFreehire(json);
}

export function parseFreehire(json: { data?: FreehireJob[] }): Job[] {
  const jobs: Job[] = [];
  for (const j of json.data ?? []) {
    if (!j.public_slug || !j.title || !j.url || j.closed_at || j.reality?.fake_freshness) continue;

    const text = cleanText(j.description ?? "");
    const location = cleanText(j.location ?? "") || (j.work_mode === "remote" ? "Remote" : "Kenya");
    const posted = j.posted_at ? new Date(j.posted_at) : undefined;

    jobs.push({
      id: `freehire:${j.public_slug}`,
      source: "freehire",
      title: cleanText(j.title),
      company: j.company ? cleanText(j.company) : undefined,
      location,
      description: text.slice(0, 1200) || undefined,
      details: text.slice(0, 3000) || undefined,
      posted: posted && !Number.isNaN(posted.getTime()) ? formatNairobi(posted) : undefined,
      // Their links carry ?utm_source=freehire.me; the employer's page is the same without it.
      url: j.url.replace(/[?&]utm_source=freehire\.me$/, ""),
    });
  }
  return jobs;
}
