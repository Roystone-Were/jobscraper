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
  // Scholarship posts (src/scholarships.ts), both WordPress.
  opportunitydesk: { marker: /<div[^>]*class="[^"]*entry-content/ },
  ofa: { marker: /<div[^>]*class="[^"]*entry-content/ },
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

/**
 * Sources whose adverts are PDFs, often titled only "Vacancies at X" with
 * several posts inside. Their text is read before the AI scores them.
 */
const PDF_SOURCES = new Set<Job["source"]>(["gaa", "jkuat", "meru"]);
export const isPdfAdvert = (job: Job) => PDF_SOURCES.has(job.source);

const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // "%PDF"

async function download(url: string, label: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`pdf ${label} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The advert's text, via Workers AI's PDF-to-Markdown conversion. */
export async function fetchPdfText(ai: Ai, job: Job): Promise<string> {
  let bytes = await download(job.url, job.source);
  if (!isPdf(bytes)) {
    // Meru links to a viewer page with the PDF embedded.
    const src = new TextDecoder().decode(bytes).match(/<(?:embed|object)[^>]*?(?:src|data)="([^"#]+\.pdf)/i)?.[1];
    if (!src) throw new Error(`pdf ${job.source}: no PDF at ${job.url}`);
    bytes = await download(new URL(src, job.url).href, job.source);
    if (!isPdf(bytes)) throw new Error(`pdf ${job.source}: not a PDF at ${src}`);
  }
  const out = await ai.toMarkdown({ name: "advert.pdf", blob: new Blob([bytes], { type: "application/pdf" }) });
  if (out.format === "error") throw new Error(`pdf ${job.source}: ${out.error}`);
  // Drop the file-metadata block (author, PDF version...) and page markers.
  const body = out.data.split(/^## Contents$/m)[1] ?? out.data;
  return body.replace(/^### Page \d+$/gm, " ");
}

/**
 * At most MAX_TEXT characters for the AI. Short adverts go whole; long ones
 * send the opening plus the text around each post matching the keywords, so
 * an "ICT Officer" on page 8 of a 20-post advert is still seen.
 */
export function pdfExcerpt(markdown: string, keywords: RegExp[]): string {
  const text = markdown.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_TEXT) return text;
  const spans: [number, number][] = [[0, 600]];
  // Adverts repeat boilerplate per post ("Self-developer" under every post's
  // competencies): skip hyphenated matches and passages already taken.
  const taken = new Set<string>();
  for (const k of keywords) {
    for (const m of text.matchAll(new RegExp(k.source, k.flags.replace("g", "") + "g"))) {
      if (m[0].startsWith("-")) continue;
      const passage = text.slice(m.index, m.index + 120);
      if (taken.has(passage)) continue;
      taken.add(passage);
      spans.push([Math.max(0, m.index - 150), m.index + 850]);
    }
  }
  if (spans.length === 1) return text.slice(0, MAX_TEXT); // no matching post
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of spans) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged.map(([from, to]) => text.slice(from, to)).join(" … ").slice(0, MAX_TEXT);
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
