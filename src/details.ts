import type { Job } from "./types";
import { salaryFromJsonLd } from "./salary";
import { formatNairobi, USER_AGENT } from "./types";

export interface Details {
  text?: string;
  /** Application deadline, formatted for display. */
  deadline?: string;
  /** Application deadline as unix ms, to skip jobs that have already closed. */
  deadlineAt?: number;
  salary?: string;
}

const MAX_TEXT = 3000;

/**
 * Where each site keeps the job description on its job page. Sites with
 * schema.org JobPosting JSON-LD use that first; `marker` is a fallback (or the
 * only option) that locates the description block in the HTML.
 */
const PAGE: Partial<Record<Job["source"], { marker?: RegExp }>> = {
  "myjobmag-ke": { marker: /<[a-z]+[^>]*class="job-details/ },
  brightermonday: {},
  corporatestaffing: {},
  untalent: {},
  impactpool: { marker: /<[a-z]+[^>]*job-description/ },
  etalent: {},
  // LinkedIn is left out on purpose: every extra request makes its search
  // requests more likely to be rate-limited.
};

/** Whether a job page can be fetched for more detail. */
export const hasDetailPage = (job: Job) => job.source in PAGE;

export async function fetchDetails(job: Job): Promise<Details> {
  const cfg = PAGE[job.source];
  if (!cfg) return {};
  const res = await fetch(job.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`details ${job.source} -> HTTP ${res.status}`);
  return extractDetails(await res.text(), cfg.marker);
}

export function extractDetails(html: string, marker?: RegExp): Details {
  const ld = jobPostingLd(html);
  let text = ld?.description ? htmlToText(ld.description) : "";

  if (marker) {
    const i = html.search(marker);
    // ~40 KB covers any description; the cap keeps CPU use small.
    const block = i >= 0 ? htmlToText(html.slice(i, i + 40_000)) : "";
    if (block.length > text.length) text = block;
  }

  const until = ld?.validThrough ? new Date(ld.validThrough) : undefined;
  const valid = until && !Number.isNaN(until.getTime());
  return {
    text: text ? text.slice(0, MAX_TEXT) : undefined,
    deadline: valid ? formatNairobi(until).split(",")[0] : undefined,
    deadlineAt: valid ? until.getTime() : undefined,
    salary: ld ? salaryFromJsonLd(ld) : undefined,
  };
}

/** The schema.org JobPosting object, if the page has one. */
function jobPostingLd(html: string): ({ description?: string; validThrough?: string } & Parameters<typeof salaryFromJsonLd>[0]) | undefined {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = [data, ...(Array.isArray(data) ? data : []), ...(data?.["@graph"] ?? [])];
      const post = nodes.find((n) => n && [n["@type"]].flat().includes("JobPosting"));
      if (post) return post;
    } catch {
      // Malformed JSON-LD is common; ignore and keep looking.
    }
  }
  return undefined;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s*\.\s*(\.\s*)+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}
