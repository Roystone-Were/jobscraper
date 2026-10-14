import type { Job } from "./types";

const COMPANY_NOISE =
  /\b(ltd|limited|plc|inc|llc|llp|co|company|corporation|corp|group|kenya|ke|the|international|intl)\b/g;
const TITLE_LOCATION_SUFFIX =
  /\s*[-–—(,|]\s*(nairobi|mombasa|kisumu|nakuru|eldoret|thika|kenya|remote|hybrid)\b.*$/i;

const normalize = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/**
 * Same job posted on several boards gets the same fingerprint:
 * normalised title + company. Jobs without a company get none, since a bare
 * title ("IT Officer") is too generic to treat as a duplicate.
 */
export function fingerprint(job: Pick<Job, "title" | "company">): string | null {
  if (!job.company) return null;
  const company = normalize(job.company).replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();
  const title = normalize(job.title.replace(TITLE_LOCATION_SUFFIX, ""));
  if (!company || !title) return null;
  return `${title}|${company}`;
}

/** 12-char key for Telegram callback data (limited to 64 bytes). FNV-1a, two seeds. */
export function shortKey(id: string): string {
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36).padStart(7, "0").slice(-6);
  };
  return fnv(0x811c9dc5) + fnv(0x9747b28c);
}
