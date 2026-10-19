import { htmlToText } from "../details";
import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

/** WordPress-style RSS job feeds. */
export const RSS_FEEDS = [
  {
    source: "myjobmag-ke",
    // Official feed; more items than the /jobs page and steadier markup.
    url: "https://www.myjobmag.co.ke/jobsxml.xml",
    splitCompany: true,
  },
  {
    source: "jobwebkenya",
    url: "https://jobwebkenya.com/feed/",
    // Titles look like "Front Office Supervisor at MGallery Hotel Collection".
    splitCompany: true,
  },
  {
    source: "oyk",
    url: "https://opportunitiesforyoungkenyans.co.ke/feed/",
    // Titles are headlines ("Nakuru County ... Hiring Clerical Officers").
    splitCompany: false,
  },
] as const satisfies Feed[];

export interface Feed {
  source: Job["source"];
  url: string;
  splitCompany: boolean;
  /** Employer to show when the feed is a single organisation's. */
  company?: string;
  /** Optional title filter, for feeds that mix job adverts with other posts. */
  keep?: RegExp;
  /** Skip items older than this (for feeds without closing dates). */
  maxAgeDays?: number;
}

/** Kiambu County careers feed: mixes adverts with shortlists and results. */
export const KIAMBU_FEED: Feed = {
  source: "kiambu",
  url: "https://kiambu.go.ke/careers/feed/",
  splitCompany: false,
  keep: /vacanc|advert|recruit|position|officer|job/i,
  maxAgeDays: 30,
};

/** County feeds that mix adverts with shortlists, tenders and news. */
export const COUNTY_FEEDS: Feed[] = [
  {
    source: "nyeri",
    url: "https://www.nyeri.go.ke/category/vacancies/feed/",
    splitCompany: false,
    company: "County Government of Nyeri",
    keep: /vacanc|advert|position|call for applications|recruit/i,
    maxAgeDays: 30,
  },
  {
    // Downloads feed: adverts are posted as files, next to tenders.
    source: "kisumu",
    url: "https://www.kisumu.go.ke/?post_type=wpdmpro&feed=rss2",
    splitCompany: false,
    company: "County Government of Kisumu",
    keep: /job advert|vacanc|recruit/i,
    maxAgeDays: 30,
  },
];

export async function fetchRss(feed: Feed): Promise<Job[]> {
  const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${feed.source} feed -> HTTP ${res.status}`);
  return parseRss(await res.text(), feed);
}

/**
 * Some feeds contain UTF-8 that was decoded as Latin-1 upstream ("â€™" for
 * "’"). Re-encode those runs as bytes and decode again; leave text alone if
 * that doesn't produce valid UTF-8.
 */
export function fixMojibake(s: string): string {
  // Some text was mangled twice upstream, so undo up to two layers.
  for (let i = 0; i < 2; i++) {
    const fixed = fixMojibakeOnce(s);
    if (fixed === s) break;
    s = fixed;
  }
  return s;
}

function fixMojibakeOnce(s: string): string {
  return s.replace(/[Â-ô][\u0080-¿]+/g, (run) => {
    if ([...run].some((c) => c.charCodeAt(0) > 0xff)) return run;
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(run, (c) => c.charCodeAt(0)),
      );
    } catch {
      return run;
    }
  });
}

const unwrap =(s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");

export function parseRss(xml: string, feed: Feed): Job[] {
  const jobs: Job[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const tag = (name: string) => {
      const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return m ? unwrap(m[1]) : undefined;
    };

    const rawTitle = tag("title");
    const link = tag("link")?.trim();
    if (!rawTitle || !link) continue;

    let title = fixMojibake(cleanText(rawTitle));
    if (feed.keep && (!feed.keep.test(title) || /shortlist|result|interview|successful/i.test(title))) continue;
    let company = feed.company;
    if (feed.splitCompany) {
      const at = title.lastIndexOf(" at ");
      if (at > 0) [title, company] = [title.slice(0, at), title.slice(at + 4)];
    }

    // Drop WordPress's "The post X appeared first on Y" footer.
    const description = tag("description")
      ?.replace(/<p>The post [\s\S]*$/, "");
    const pubDate = tag("pubDate");
    if (feed.maxAgeDays && pubDate && Date.now() - Date.parse(pubDate) > feed.maxAgeDays * 86_400_000) continue;
    // WordPress feeds carry the whole post here; kept for the AI's second look.
    const body = tag("content:encoded");

    jobs.push({
      id: `${feed.source}:${cleanText(tag("guid") ?? link)}`,
      source: feed.source,
      title,
      company,
      description: description ? fixMojibake(cleanText(description)) : undefined,
      posted: pubDate ? formatNairobi(new Date(pubDate)) : undefined,
      details: body ? fixMojibake(htmlToText(body)).slice(0, 3000) : undefined,
      url: link,
    });
  }
  return jobs;
}
