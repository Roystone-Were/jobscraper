import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

// Its RSS feed only carries blog posts, so read the /jobs/ listing page.
const URL = "https://www.corporatestaffing.co.ke/jobs/";

export async function fetchCorporateStaffing(): Promise<Job[]> {
  const res = await fetch(URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Corporate Staffing -> HTTP ${res.status}`);
  return parseCorporateStaffing(await res.text());
}

export function parseCorporateStaffing(html: string): Job[] {
  const jobs: Job[] = [];
  // The page is ~400 KB; only the ~80 KB job list matters. Trimming first keeps
  // parsing inside the Workers free-plan CPU budget.
  const start = html.indexOf('<h2 class="entry-title">');
  if (start < 0) return jobs;
  const lastCard = html.lastIndexOf('<h2 class="entry-title">');
  const end = html.indexOf("</article>", lastCard);
  const list = html.slice(start, end > 0 ? end : undefined);

  for (const block of list.split('<h2 class="entry-title">').slice(1)) {
    const link = block.match(/<a href="(https:\/\/www\.corporatestaffing\.co\.ke\/job\/([^"/]+)\/?)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;

    // Titles look like "Network Engineer Job KenTrade" or "... Job ICT Authority Nairobi, Kenya".
    let title = cleanText(link[3]);
    let company: string | undefined;
    const at = title.lastIndexOf(" Job ");
    if (at > 0) [title, company] = [title.slice(0, at), title.slice(at + 5)];

    const posted = block.match(/<time class="entry-date published" datetime="([^"]+)"/);
    const summary = block.match(/<div class="entry-summary">([\s\S]*?)<\/div>/);

    jobs.push({
      id: `corporatestaffing:${link[2]}`,
      source: "corporatestaffing",
      title,
      company,
      description: summary ? cleanText(summary[1]) : undefined,
      posted: posted ? formatNairobi(new Date(posted[1])) : undefined,
      url: link[1],
    });
  }
  return jobs;
}
