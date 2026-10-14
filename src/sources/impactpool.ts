import { cleanText, type Job, USER_AGENT } from "../types";

// UN, NGO and international-organisation jobs located in Kenya.
const URL = "https://www.impactpool.org/countries/Kenya";

export async function fetchImpactpool(): Promise<Job[]> {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Impactpool -> HTTP ${res.status}`);
  return parseImpactpool(await res.text());
}

export function parseImpactpool(html: string): Job[] {
  const jobs: Job[] = [];
  for (const card of html.split("<div class='job'>").slice(1)) {
    const link = card.match(/href="\/jobs\/(\d+)"/);
    const title = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!link || !title) continue;

    // Card lines in order: organisation, location, level.
    const lines = [...card.matchAll(/type='bodyEmphasis'>([\s\S]*?)(?:<img|<\/div>)/g)].map((m) => cleanText(m[1]));
    const [company, location, level] = lines;

    jobs.push({
      id: `impactpool:${link[1]}`,
      source: "impactpool",
      title: cleanText(title[1]),
      company: company || undefined,
      location: location || "Kenya",
      description: level ? `Level: ${level}` : undefined,
      url: `https://www.impactpool.org/jobs/${link[1]}`,
    });
  }
  return jobs;
}
