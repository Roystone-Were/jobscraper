import { cleanText, type Job, USER_AGENT } from "../types";

const URL = "https://www.brightermonday.co.ke/jobs";

export async function fetchBrighterMonday(): Promise<Job[]> {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`BrighterMonday -> HTTP ${res.status}`);
  return parseBrighterMonday(await res.text());
}

export function parseBrighterMonday(html: string): Job[] {
  const jobs: Job[] = [];
  const cards = html.split('data-cy="listing-cards-components"').slice(1);

  for (const card of cards) {
    const link = card.match(
      /href="(https:\/\/www\.brightermonday\.co\.ke\/listings\/([^"]+))"[\s\S]*?data-cy="listing-title-link"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/,
    );
    if (!link) continue;

    const company = card.match(/<p class="text-sm text-blue-700[^"]*">([\s\S]*?)<\/p>/);
    const location = card.match(/<span\s+class="[^"]*bg-brand-secondary-100[^"]*">([\s\S]*?)<\/span>/);
    const posted = card.match(/<p class="[^"]*text-gray-700 text-loading-animate">([^<]*ago)<\/p>/);
    const desc = card.match(/<p class="text-sm font-normal text-gray-700 md:text-gray-500[^"]*">([\s\S]*?)<\/p>/);

    jobs.push({
      id: `brightermonday:${link[2]}`,
      source: "brightermonday",
      title: cleanText(link[3]),
      company: company ? cleanText(company[1]) : undefined,
      location: location ? cleanText(location[1]) : undefined,
      posted: posted ? cleanText(posted[1]) : undefined,
      description: desc ? cleanText(desc[1]) : undefined,
      url: link[1],
    });
  }
  return jobs;
}
