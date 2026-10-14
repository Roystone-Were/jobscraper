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
] as const satisfies { source: Job["source"]; url: string; splitCompany: boolean }[];

type Feed = (typeof RSS_FEEDS)[number];

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
    let company: string | undefined;
    if (feed.splitCompany) {
      const at = title.lastIndexOf(" at ");
      if (at > 0) [title, company] = [title.slice(0, at), title.slice(at + 4)];
    }

    // Drop WordPress's "The post X appeared first on Y" footer.
    const description = tag("description")
      ?.replace(/<p>The post [\s\S]*$/, "");
    const pubDate = tag("pubDate");

    jobs.push({
      id: `${feed.source}:${cleanText(tag("guid") ?? link)}`,
      source: feed.source,
      title,
      company,
      description: description ? fixMojibake(cleanText(description)) : undefined,
      posted: pubDate ? formatNairobi(new Date(pubDate)) : undefined,
      url: link,
    });
  }
  return jobs;
}
