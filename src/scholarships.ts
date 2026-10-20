import type { Feed } from "./sources/rss";
import { formatNairobi, type Job } from "./types";

/**
 * Scholarship, short-course and fellowship feeds, fetched only when an
 * EXTRA_PROFILES entry sets `scholarships`. Their posts never go through the
 * main (IT) scoring; see scoreExtraProfiles in src/extra.ts.
 */
export const SCHOLARSHIP_FEEDS: (Feed & { name: string })[] = [
  { name: "opportunitydesk:masters", source: "opportunitydesk", url: "https://opportunitydesk.org/category/fellowships-and-scholarships/masters-postgraduate/feed/", splitCompany: false },
  { name: "opportunitydesk:short-courses", source: "opportunitydesk", url: "https://opportunitydesk.org/category/fellowships-and-scholarships/short-courses/feed/", splitCompany: false },
  { name: "opportunitydesk:fellowships", source: "opportunitydesk", url: "https://opportunitydesk.org/category/fellowships/feed/", splitCompany: false },
  { name: "ofa:masters", source: "ofa", url: "https://www.opportunitiesforafricans.com/category/scholarships/masters/feed/", splitCompany: false },
  { name: "ofa:fellowships", source: "ofa", url: "https://www.opportunitiesforafricans.com/category/fellowships/feed/", splitCompany: false },
  { name: "ofa:training", source: "ofa", url: "https://www.opportunitiesforafricans.com/category/training-and-conferences/feed/", splitCompany: false },
];

const SOURCES = new Set<string>(SCHOLARSHIP_FEEDS.map((f) => f.source));
export const isScholarship = (job: Pick<Job, "source">) => SOURCES.has(job.source);
/** For stored ids ("ofa:<guid>"), e.g. pending alerts. */
export const isScholarshipId = (id: string) => SOURCES.has(id.split(":")[0]);
export const SCHOLARSHIP_SOURCES = [...SOURCES];

// Round-ups ("27 Scholarship Opportunities Closing in October") and advice posts.
const NOT_AN_OFFER = /^\d+\s|\?|\bhow to\b|\btips\b|what to do|currently open|closing in\b/i;
const MASTERS = /\bmasters?\b|\bmaster['’]s|\bmsc\b|\bm\.sc|postgraduate|\bgraduate (?:scholarships?|programmes?|programs?)\b/i;
const OTHER_LEVEL = /\bundergraduate|\bbachelor|\bph\.?d\b|\bdoctora|\bpost-?doc/i;
// "for Nigerian Students", "for young South Africans", "for Afghan Women": open to one other country or region.
const OTHER_COUNTRY =
  /\bfor (?:young |talented |emerging )?(?:Nigerian|Ghanaian|South African|Southern African|West African|Ugandan|Tanzanian|Rwandan|Ethiopian|Somali|Zambian|Zimbabwean|Namibian|Malawian|Cameroonian|Egyptian|Moroccan|Afghan|Pakistani)s?\b/;

/** Cheap title checks so obvious misfits don't use the AI or a page fetch. */
export function worthScoring(job: Job, now: number): boolean {
  if (job.deadlineAt && job.deadlineAt < now) return false;
  if (NOT_AN_OFFER.test(job.title) || OTHER_COUNTRY.test(job.title)) return false;
  return !(OTHER_LEVEL.test(job.title) && !MASTERS.test(job.title));
}

/**
 * Feed summaries open with the closing date: "Deadline: January 6, 2027",
 * "Application Deadline: 25th October, 2026 5 pm BST". Taken as 23:59 Nairobi.
 */
export function withDeadline(job: Job): Job {
  const m = `${job.description ?? ""}`.match(/deadline\s*:?\s*([A-Za-z0-9 ,]{4,30}?\b20\d\d)\b/i);
  if (!m) return job;
  const day = m[1].replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const at = Date.parse(`${day} 23:59 GMT+0300`);
  if (Number.isNaN(at)) return job;
  return { ...job, deadline: formatNairobi(new Date(at)).split(",")[0], deadlineAt: at };
}
