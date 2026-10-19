import { htmlToText } from "../details";
import { cleanText, decodeEntities, formatNairobi, type Job, USER_AGENT } from "../types";

// NGO and UN jobs in Kenya (C131) under Information and Communications
// Technology (CC6866). The JSON API needs an approved appname; the RSS doesn't.
const URL = "https://reliefweb.int/jobs/rss.xml?advanced-search=%28C131%29_%28CC6866%29";

export async function fetchReliefWeb(): Promise<Job[]> {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`ReliefWeb -> HTTP ${res.status}`);
  return parseReliefWeb(await res.text());
}

export function parseReliefWeb(xml: string): Job[] {
  const jobs: Job[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const tag = (name: string) => item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
    const title = tag("title");
    const link = tag("link")?.trim();
    const id = link?.match(/\/job\/(\d+)/)?.[1];
    if (!title || !link || !id) continue;

    // The body is escaped HTML that starts with country/org/closing-date tags.
    const body = decodeEntities(tag("description") ?? "");
    const org = body.match(/<div class="tag source">Organization:\s*([\s\S]*?)<\/div>/);
    const closes = body.match(/Closing date:\s*([^<]+)</)?.[1].trim();
    const at = closes ? Date.parse(`${closes} 20:59 UTC`) : NaN;
    const text = htmlToText(body.replace(/<div class="(tag|date)[^"]*">[\s\S]*?<\/div>/g, " "));
    const pubDate = tag("pubDate");

    jobs.push({
      id: `reliefweb:${id}`,
      source: "reliefweb",
      title: cleanText(title),
      company: org ? cleanText(org[1]) : undefined,
      location: "Kenya",
      description: text.slice(0, 1200) || undefined,
      details: text.slice(0, 3000) || undefined,
      posted: pubDate ? formatNairobi(new Date(pubDate)) : undefined,
      deadline: closes,
      deadlineAt: Number.isNaN(at) ? undefined : at,
      url: link,
    });
  }
  return jobs;
}
