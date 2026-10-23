import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

// Remote job boards, for remote help-desk / IT support roles open to someone
// in Kenya. They list every field, so only IT-looking titles are kept here;
// otherwise they would eat the daily AI allowance.

/** IT and support titles worth scoring. "IT"/"ICT" are matched case-sensitively. */
const IT_TITLE =
  /\b(help ?desk|service ?desk|desktop|technical support|tech support|product support|support (engineer|specialist|technician|analyst|agent)|sys(tems?)? ?admin\w*|network|noc|infrastructure|end.user|field (engineer|technician)|technician|linux|windows|microsoft 365|m365|intune|active directory|cyber ?security|security analyst|soc analyst)\b/i;
export const isItTitle = (title: string) => /\bI(C)?T\b/.test(title) || IT_TITLE.test(title);

/** Words in a job's allowed-locations field that include Kenya. */
const OPEN_TO_KENYA = /anywhere|worldwide|global|emea|africa|kenya/i;

const text = (html: string | undefined) => (html ? cleanText(html) : "");

/**
 * Himalayas: jobs whose location rules include Kenya (worldwide or listing it).
 * About 40 a day, newest first, 20 per page; one page per rotation slot is plenty.
 */
const HIMALAYAS = "https://himalayas.app/jobs/api/search?country=Kenya&sort=recent";

interface HimalayasJob {
  title?: string;
  companyName?: string;
  locationRestrictions?: string[];
  description?: string;
  excerpt?: string;
  pubDate?: number;
  applicationLink?: string;
  guid?: string;
}

export async function fetchHimalayas(): Promise<Job[]> {
  const res = await fetch(HIMALAYAS, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`himalayas -> HTTP ${res.status}`);
  return parseHimalayas((await res.json()) as { jobs?: HimalayasJob[] });
}

export function parseHimalayas(json: { jobs?: HimalayasJob[] }): Job[] {
  const jobs: Job[] = [];
  for (const j of json.jobs ?? []) {
    if (!j.title || !j.guid || !isItTitle(j.title)) continue;
    const body = text(j.description);
    const where = j.locationRestrictions?.length ? j.locationRestrictions.join(", ") : "Worldwide";
    jobs.push({
      id: `himalayas:${j.guid.replace(/^https?:\/\/[^/]+\//, "")}`,
      source: "himalayas",
      title: cleanText(j.title),
      company: j.companyName ? cleanText(j.companyName) : undefined,
      location: `Remote (${where})`,
      description: (text(j.excerpt) || body).slice(0, 1200) || undefined,
      details: body.slice(0, 3000) || undefined,
      posted: j.pubDate ? formatNairobi(new Date(j.pubDate * 1000)) : undefined,
      url: j.guid,
    });
  }
  return jobs;
}

/** We Work Remotely category feeds; items carry a <region> such as "Anywhere in the World". */
export const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-customer-support-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];
const WWR_MAX_AGE_DAYS = 30;

export async function fetchWwr(): Promise<Job[]> {
  const pages = await Promise.all(
    WWR_FEEDS.map(async (url) => {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`wwr -> HTTP ${res.status}`);
      return res.text();
    }),
  );
  return pages.flatMap(parseWwr);
}

export function parseWwr(xml: string): Job[] {
  const jobs: Job[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const tag = (name: string) => item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
    const raw = tag("title");
    const link = tag("link")?.trim();
    const region = cleanText(tag("region") ?? "");
    if (!raw || !link || !OPEN_TO_KENYA.test(region)) continue;

    // Titles look like "Acme Inc: IT Support Specialist".
    const full = cleanText(raw);
    const colon = full.indexOf(": ");
    const [company, title] = colon > 0 ? [full.slice(0, colon), full.slice(colon + 2)] : [undefined, full];
    if (!isItTitle(title)) continue;

    // Feeds keep months-old adverts.
    const pubDate = tag("pubDate");
    if (pubDate && Date.now() - Date.parse(pubDate) > WWR_MAX_AGE_DAYS * 86_400_000) continue;

    // The description is escaped HTML: the first pass decodes it, the second strips the tags.
    const body = cleanText(cleanText(tag("description") ?? ""));
    jobs.push({
      id: `wwr:${link.replace(/^https?:\/\/[^/]+\//, "")}`,
      source: "wwr",
      title,
      company,
      location: `Remote (${region})`,
      description: body.slice(0, 1200) || undefined,
      details: body.slice(0, 3000) || undefined,
      posted: pubDate ? formatNairobi(new Date(pubDate)) : undefined,
      url: link,
    });
  }
  return jobs;
}

/** Jobicy: remote jobs open anywhere (~40 a week across all fields). */
const JOBICY = "https://jobicy.com/api/v2/remote-jobs?count=50&geo=anywhere";

interface JobicyJob {
  id?: number;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobGeo?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

export async function fetchJobicy(): Promise<Job[]> {
  const res = await fetch(JOBICY, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`jobicy -> HTTP ${res.status}`);
  return parseJobicy((await res.json()) as { jobs?: JobicyJob[] });
}

export function parseJobicy(json: { jobs?: JobicyJob[] }): Job[] {
  const jobs: Job[] = [];
  for (const j of json.jobs ?? []) {
    if (!j.id || !j.url || !j.jobTitle || !isItTitle(j.jobTitle) || !OPEN_TO_KENYA.test(j.jobGeo ?? "")) continue;
    const body = text(j.jobDescription);
    const posted = j.pubDate ? new Date(j.pubDate) : undefined;
    jobs.push({
      id: `jobicy:${j.id}`,
      source: "jobicy",
      title: cleanText(j.jobTitle),
      company: j.companyName ? cleanText(j.companyName) : undefined,
      location: `Remote (${cleanText(j.jobGeo ?? "")})`,
      description: (text(j.jobExcerpt) || body).slice(0, 1200) || undefined,
      details: body.slice(0, 3000) || undefined,
      posted: posted && !Number.isNaN(posted.getTime()) ? formatNairobi(posted) : undefined,
      url: j.url,
    });
  }
  return jobs;
}
