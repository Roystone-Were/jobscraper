export interface Job {
  /** Unique across sources: "<source>:<site job id>". */
  id: string;
  source:
    | "myjobmag-ke"
    | "brightermonday"
    | "jobwebkenya"
    | "oyk"
    | "corporatestaffing"
    | "untalent"
    | "impactpool"
    | "telegram"
    | "employer"
    | "etalent"
    | "fuzu"
    | "kenyajob"
    | "psc"
    | "icta"
    | "nakuru"
    | "kiambu"
    | "reliefweb"
    | "gaa"
    | "nyamira"
    | "meru"
    | "jkuat"
    | "nyeri"
    | "kisumu"
    | "linkedin";
  title: string;
  company?: string;
  location?: string;
  description?: string;
  posted?: string;
  /** Normalised title+company, for spotting the same job on several boards. */
  fingerprint?: string | null;
  /** Set when sent to Telegram: compact id for button callbacks, and send time. */
  shortKey?: string;
  notifiedAt?: number;
  /** Full job text (feed body or job page), used for a second AI look. */
  details?: string;
  /** Application deadline from the job page, formatted for display. */
  deadline?: string;
  deadlineAt?: number;
  /** Pay with its basis, e.g. "KES 46,120–65,860/month (advertised)". See src/salary.ts. */
  salary?: string;
  /** AI market pay estimate; becomes `salary` only if nothing better is found. */
  payEstimate?: string;
  /** AI fit score 1-10 against the CV, with a one-line reason. */
  score?: number;
  scoreReason?: string;
  /** From the AI: what in the ad matches the CV, and what the CV lacks. */
  strengths?: string[];
  gaps?: string[];
  url: string;
}

export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** Optional secret enabling GET /run?key=... for manual runs. */
  RUN_KEY?: string;
  /** Telegram sends this in a header so /telegram only accepts real updates. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Secret the PC sends with POST /linkedin (pc/linkedin-push.ps1). Unset = endpoint off. */
  LINKEDIN_PUSH_KEY?: string;

  INCLUDE_KEYWORDS: string;
  EXCLUDE_KEYWORDS: string;
  MYJOBMAG_QUERIES: string;
  LINKEDIN_KEYWORDS: string;
  LINKEDIN_LOCATION: string;
  /** LinkedIn searches per run, rotating through LINKEDIN_KEYWORDS. */
  LINKEDIN_PER_RUN: string;
  /** "on" / "off". Overridable from Telegram with /ai. */
  AI_SCORING: string;
  /** Minimum AI score (1-10) to send an alert. Overridable with /minscore. */
  MIN_SCORE: string;
  /** Max AI calls per Nairobi day before falling back to keywords. */
  AI_DAILY_LIMIT: string;
}

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
  /** Approved ReliefWeb API appname. Unset = ReliefWeb sources fail and show in health. */
  RELIEFWEB_APPNAME?: string;
    .filter(Boolean);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Creating an Intl formatter costs ~10 ms of CPU the first time, so share one.
let nairobiFormat: Intl.DateTimeFormat | undefined;

/** "14 Oct 2026, 17:20" in Nairobi time. */
export function formatNairobi(date: Date): string {
  nairobiFormat ??= new Intl.DateTimeFormat("en-KE", { timeZone: "Africa/Nairobi", dateStyle: "medium", timeStyle: "short" });
  return nairobiFormat.format(date);
}
