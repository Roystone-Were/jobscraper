import { cleanText, type Job, USER_AGENT } from "../types";

// UN jobs pre-filtered to IT & Telecom, entry/mid/volunteer level, in Kenya.
const URL = "https://untalent.org/jobs/in-it-telecom/contract-entry+mid+volunteer/kenya";

export async function fetchUnTalent(): Promise<Job[]> {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`UNTalent -> HTTP ${res.status}`);
  return parseUnTalent(await res.text());
}

export function parseUnTalent(html: string): Job[] {
  const jobs: Job[] = [];
  for (const card of html.split('<div class="job-card card').slice(1)) {
    const link = card.match(/<div class="job-title">\s*<h1><a href="(https:\/\/untalent\.org\/jobs\/([^"/]+))">([\s\S]*?)<\/a>/);
    if (!link) continue;

    // The organisation name is the text link after the logo link.
    const org = card.match(/<div class="organisation">[\s\S]*?<div>\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const city = card.match(/<div class="locations">[\s\S]*?<img[^>]*class="flag">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    const summary = card.match(/<div class="job-summary">([\s\S]*?)<\/div>/);

    jobs.push({
      id: `untalent:${link[2]}`,
      source: "untalent",
      title: cleanText(link[3]),
      company: org ? cleanText(org[1]) : undefined,
      location: city ? `${cleanText(city[1])}, Kenya` : "Kenya",
      description: summary ? cleanText(summary[1]) : undefined,
      url: link[1],
    });
  }
  return jobs;
}
