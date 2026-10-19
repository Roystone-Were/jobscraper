import { htmlToText } from "../details";
import { kesRange, salaryFromCsg } from "../salary";
import { cleanText, decodeEntities, formatNairobi, type Job, USER_AGENT } from "../types";

async function get(url: string, label: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${label} -> HTTP ${res.status}`);
  return res.text();
}

// ---------- Fuzu: job data is embedded as JSON for React; no browser needed.

export const FUZU_PAGES = {
  latest: "https://www.fuzu.com/kenya/job",
  it: "https://www.fuzu.com/kenya/job/computers-software",
};

export async function fetchFuzu(url: string): Promise<Job[]> {
  return parseFuzu(await get(url, "Fuzu"));
}

interface FuzuJob {
  id: number;
  title: string;
  company_name?: string;
  location?: string;
  description?: string;
  requirements?: string;
  campaign_start_date?: number;
  campaign_end_date?: number;
  salary_min_cents?: number;
  salary_max_cents?: number;
  salary_currency?: string | null;
  slug: string;
}

export function parseFuzu(html: string): Job[] {
  const m = html.match(/<script type="application\/json" class="js-react-on-rails-component"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const data = JSON.parse(m[1]) as { context?: { page_info?: { jobs?: FuzuJob[] } } };
  return (data.context?.page_info?.jobs ?? []).map((j) => {
    const text = htmlToText(`${j.description ?? ""} ${j.requirements ?? ""}`);
    return {
      id: `fuzu:${j.id}`,
      source: "fuzu" as const,
      title: cleanText(j.title),
      company: j.company_name || undefined,
      location: j.location || undefined,
      description: text.slice(0, 1200) || undefined,
      details: text.slice(0, 3000) || undefined,
      posted: j.campaign_start_date ? formatNairobi(new Date(j.campaign_start_date * 1000)) : undefined,
      deadline: j.campaign_end_date ? formatNairobi(new Date(j.campaign_end_date * 1000)).split(",")[0] : undefined,
      deadlineAt: j.campaign_end_date ? j.campaign_end_date * 1000 : undefined,
      salary:
        (j.salary_min_cents || j.salary_max_cents) && (j.salary_currency ?? "KES") === "KES"
          ? `${kesRange((j.salary_min_cents ?? 0) / 100, (j.salary_max_cents ?? 0) / 100)}/month (advertised)`
          : undefined,
      url: `https://www.fuzu.com/kenya/jobs/${j.slug}`,
    };
  });
}

// ---------- Kenyajob.com: "IT, new technologies" category.
// Not in use: the site answers HTTP 403 to requests from Cloudflare Workers.

const KENYAJOB_IT = "https://www.kenyajob.com/job-vacancies-search-kenya?f%5B0%5D=im_field_offre_metiers%3A31";

export async function fetchKenyajob(): Promise<Job[]> {
  return parseKenyajob(await get(KENYAJOB_IT, "Kenyajob"));
}

export function parseKenyajob(html: string): Job[] {
  const jobs: Job[] = [];
  for (const card of html.split('<div class="card card-job"').slice(1)) {
    // The site re-dates old ads, so the numeric id (not the date) is the key.
    const link = card.match(/<h3><a href="(\/job-vacancies-kenya\/[^"]*-(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const company = card.match(/class="card-job-company company-name">([\s\S]*?)<\/a>/);
    const desc = card.match(/<div class="card-job-description">([\s\S]*?)<\/div>/);
    const date = card.match(/<time datetime="([^"]+)"/);
    jobs.push({
      id: `kenyajob:${link[2]}`,
      source: "kenyajob",
      title: cleanText(link[3]),
      company: company ? cleanText(company[1]) : undefined,
      description: desc ? cleanText(desc[1]).slice(0, 1200) : undefined,
      posted: date?.[1],
      url: `https://www.kenyajob.com${link[1]}`,
    });
  }
  return jobs;
}

// ---------- Public Service Commission: active national government adverts.

const PSC = "https://pscims.publicservice.go.ke/jobs/ActiveJobsAdverts.aspx";

export async function fetchPsc(): Promise<Job[]> {
  return parsePsc(await get(PSC, "PSC"));
}

const dmy = (s: string) => {
  const m = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  // Close of day in Nairobi.
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 20, 59) : undefined;
};

export function parsePsc(html: string): Job[] {
  const jobs: Job[] = [];
  const table = html.slice(html.indexOf('id="DataGrid2"'));
  for (const row of table.split("<tr").slice(2)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1]));
    // ## | Advert No | Position | Scale | Ministry | Vacancies | Years | Category | Advertised | Closes
    if (cells.length < 10 || !cells[1]) continue;
    const [, advert, position, scale, ministry, vacancies, years, category, , closes] = cells;
    if (/serving officers only/i.test(category)) continue; // internal promotions
    const closesAt = dmy(closes);
    jobs.push({
      id: `psc:${advert}`,
      source: "psc",
      title: position,
      company: ministry,
      location: "Kenya",
      description: `${scale}; ${vacancies} post(s); ${years} years' experience required; ${category}. Apply via the PSC portal, advert ${advert}.`,
      deadline: closes,
      deadlineAt: closesAt,
      salary: salaryFromCsg(scale),
      url: PSC,
    });
  }
  return jobs;
}

// ---------- ICT Authority: usually empty, highly relevant when it isn't.

const ICTA = "https://icta.go.ke/current-vacancies";

export async function fetchIcta(): Promise<Job[]> {
  return parseIcta(await get(ICTA, "ICT Authority"));
}

export function parseIcta(html: string): Job[] {
  const jobs: Job[] = [];
  const t = html.indexOf('<table class="data-table"');
  if (t < 0) return jobs;
  const body = html.slice(t, html.indexOf("</table>", t));
  for (const row of body.split("<tr").slice(1)) {
    // Role | Department | Type | Closing date
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1]));
    if (cells.length < 3 || !cells[0]) continue;
    const [role, dept, type, closes] = cells;
    const at = closes ? Date.parse(`${closes} 20:59 UTC`) : NaN;
    jobs.push({
      id: `icta:${role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${closes ?? ""}`,
      source: "icta",
      title: role,
      company: "ICT Authority",
      location: "Nairobi, Kenya",
      description: `${dept} department; ${type}.`,
      deadline: closes,
      deadlineAt: Number.isNaN(at) ? undefined : at,
      url: ICTA,
    });
  }
  return jobs;
}

// ---------- County public service boards.

const NAKURU = "https://recruitment.nakuru.go.ke/careers";

export async function fetchNakuru(): Promise<Job[]> {
  return parseNakuru(await get(NAKURU, "Nakuru County"));
}

export function parseNakuru(html: string): Job[] {
  const jobs: Job[] = [];
  for (const card of html.split('<div class="job-card">').slice(1)) {
    const title = card.match(/<h3>([\s\S]*?)<\/h3>/);
    const link = card.match(/href="(https:\/\/recruitment\.nakuru\.go\.ke\/jobs\/([^"]+))"/);
    if (!title || !link) continue;
    const meta = [...card.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => cleanText(m[1]));
    if (meta.some((m) => /\binternal\b/i.test(m))) continue; // serving staff only
    const closes = meta.find((m) => m.startsWith("⏰"))?.replace("⏰", "").trim();
    const grade = card.match(/<p>([\s\S]*?)<\/p>/);
    const salary = card.match(/<div class="salary">([\s\S]*?)<\/div>/);
    const at = closes ? Date.parse(`${closes} 20:59 UTC`) : NaN;
    jobs.push({
      id: `nakuru:${link[2]}`,
      source: "nakuru",
      title: cleanText(title[1]),
      company: "Nakuru County Public Service Board",
      location: "Nakuru, Kenya",
      description: [grade && cleanText(grade[1]), ...meta.filter((m) => !m.startsWith("⏰")), salary && `KES ${cleanText(salary[1])}`]
        .filter(Boolean)
        .join("; "),
      deadline: closes,
      deadlineAt: Number.isNaN(at) ? undefined : at,
      salary: salary ? `KES ${cleanText(salary[1]).replace(/\s*[-–]\s*/, "–")}/month (advertised)` : undefined,
      url: link[1],
    });
  }
  return jobs;
}

// ---------- eTalent: hosted job boards used by Kenyan employers and agencies.

/** Boards on etalent.net: subdomain → organisation. */
export const ETALENT_BOARDS = [{ slug: "peoplefoco", name: "People Foco Agency" }];

export async function fetchEtalent(board: (typeof ETALENT_BOARDS)[number]): Promise<Job[]> {
  return parseEtalent(await get(`https://${board.slug}.etalent.net/`, `eTalent ${board.slug}`), board);
}

export function parseEtalent(html: string, board: (typeof ETALENT_BOARDS)[number]): Job[] {
  const jobs: Job[] = [];
  const t = html.indexOf("<tbody");
  if (t < 0) return jobs;
  // Columns: Reference | Title | Location | Salary | Closing date | actions
  for (const row of html.slice(t, html.indexOf("</tbody>", t)).split("<tr").slice(1)) {
    const link = row.match(/<a href="(\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => cleanText(c[1]));
    if (!link || cells.length < 5) continue;
    const [ref, , location, pay] = cells;
    // Show the date as the board prints it: its timestamp is 23:59 UTC, which is
    // already the next day in Nairobi.
    const closes = row.match(/<time datetime="([^"]+)"[^>]*>([^<]*)<\/time>/);
    const at = closes ? Date.parse(closes[1]) : NaN;
    jobs.push({
      id: `etalent:${board.slug}:${ref || link[1]}`,
      source: "etalent",
      title: cleanText(link[2]),
      company: board.name,
      location: location?.replace(/\s*,\s*\d{5}$/, ""),
      // Only when an amount is given ("per month" alone means undisclosed).
      salary: /\d/.test(pay ?? "") ? `KES ${pay.replace(/KSh\s?/g, "").replace(/\s+to\s+/, "–")} (advertised)` : undefined,
      deadline: closes?.[2].trim() || undefined,
      deadlineAt: Number.isNaN(at) ? undefined : at,
      url: `https://${board.slug}.etalent.net${link[1]}`,
    });
  }
  return jobs;
}

// ---------- Government Advertising Agency: national government adverts
// (ministries, parastatals, public universities) in one table. Titles are
// generic ("Vacancies at KRA"); the positions are only in the PDF.

const GAA = "https://gaa.go.ke/job-adverts";

export async function fetchGaa(): Promise<Job[]> {
  return parseGaa(await get(GAA, "GAA"));
}

/** "28th October, 2026" / "21 October, 2026." → close of that day in Nairobi. */
const longDate = (s: string) => {
  const t = Date.parse(`${s.replace(/(\d+)(st|nd|rd|th)\b/, "$1").replace(/[,.]/g, "").trim()} 20:59 UTC`);
  return Number.isNaN(t) ? undefined : t;
};

// Built once: the page is ~650 KB and CPU time on the free plan is tight.
const GAA_CELL = Object.fromEntries(
  ["title", "field-advert-attachment", "field-recruiting-agency", "field-submission-date"].map((f) => [
    f,
    new RegExp(`views-field-${f}">([\\s\\S]*?)</td>`),
  ]),
);

export function parseGaa(html: string, now = Date.now()): Job[] {
  const jobs: Job[] = [];
  // ~450 rows back to 2024, newest first; only the top ones can still be open.
  for (const row of html.slice(0, 250_000).split("<tr").slice(2, 120)) {
    const cell = (field: string) => row.match(GAA_CELL[field])?.[1];
    const title = cell("title");
    const pdf = cell("field-advert-attachment")?.match(/href="([^"]+)"/)?.[1];
    if (!title || !pdf) continue;
    const closes = cleanText(cell("field-submission-date") ?? "").replace(/\.$/, "");
    const at = longDate(closes);
    if (!at || at < now) continue; // closed, or no date to tell
    const agency = cleanText(cell("field-recruiting-agency") ?? "");
    jobs.push({
      id: `gaa:${pdf}`,
      source: "gaa",
      title: cleanText(title),
      company: agency || undefined,
      location: "Kenya",
      description: `Government advert (PDF) listing one or more posts at ${agency || "a public body"}; the posts are named only in the PDF.`,
      deadline: closes,
      deadlineAt: at,
      url: new URL(pdf, GAA).href,
    });
  }
  return jobs;
}

// ---------- Nyamira County Public Service Board: the job list is JSON in the
// page's data-page attribute (Laravel/Inertia).

const NYAMIRA = "https://cpsb.nyamira.go.ke/";

export async function fetchNyamira(): Promise<Job[]> {
  return parseNyamira(await get(NYAMIRA, "Nyamira County"));
}

interface NyamiraJob {
  id: number;
  title: string;
  job_group?: string;
  description?: string;
  positions?: number;
  deadline?: string;
  status?: string;
  created_at?: string;
}

export function parseNyamira(html: string, now = Date.now()): Job[] {
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) return [];
  const data = JSON.parse(decodeEntities(m[1])) as { props?: { vacancies?: { data?: NyamiraJob[] } } };
  return (data.props?.vacancies?.data ?? [])
    .filter((j) => j.status !== "Closed" && !(j.deadline && Date.parse(j.deadline) < now))
    .map((j) => {
      const text = htmlToText(j.description ?? "");
      // Deadlines are midnight UTC of the closing day; show that day.
      const at = j.deadline ? Date.parse(j.deadline) + 21 * 3_600_000 : undefined;
      return {
        id: `nyamira:${j.id}`,
        source: "nyamira" as const,
        // Titles keep the advert's numbering: "26.\tMEDICAL ENGINEERING TECHNICIAN III".
        title: cleanText(j.title.replace(/^\d+\.\s*/, "")),
        company: "Nyamira County Public Service Board",
        location: "Nyamira, Kenya",
        description: [j.job_group, j.positions && `${j.positions} post(s)`, text.slice(0, 900)].filter(Boolean).join("; "),
        details: text.slice(0, 3000) || undefined,
        posted: j.created_at ? formatNairobi(new Date(j.created_at)) : undefined,
        deadline: j.deadline?.slice(0, 10),
        deadlineAt: at,
        url: NYAMIRA,
      };
    });
}

// ---------- Meru County: a downloads table mixing adverts with shortlists.

const MERU = "https://meru.go.ke/jobs-vacancies/";

export async function fetchMeru(): Promise<Job[]> {
  return parseMeru(await get(MERU, "Meru County"));
}

export function parseMeru(html: string, now = Date.now()): Job[] {
  const jobs: Job[] = [];
  for (const row of html.matchAll(/<tr><td nowrap>([^<]*)<\/td><td><a\s+href="(resource\/(\d+)[^"]*)"[^>]*>([^<]*)<\/a>/g)) {
    const [, date, path, id, rawTitle] = row;
    const title = cleanText(rawTitle);
    if (!/advert|vacanc|recruit|position/i.test(title) || /shortlist|interview|notice|result|board members/i.test(title)) continue;
    // No closing dates; county adverts usually run 2-3 weeks.
    const posted = Date.parse(date.replace(/-/g, " "));
    if (Number.isNaN(posted) || now - posted > 30 * 86_400_000) continue;
    jobs.push({
      id: `meru:${id}`,
      source: "meru",
      title,
      company: "Meru County Public Service Board",
      location: "Meru, Kenya",
      description: "County advert (PDF); the posts are named only in the PDF.",
      posted: date,
      // Relative to the page's <base href>, the site root.
      url: new URL(path, "https://meru.go.ke/").href,
    });
  }
  return jobs;
}

// ---------- JKUAT: advert PDFs; the upload month in the path is the only date.

const JKUAT = "https://www.jkuat.ac.ke/vacancies/";

export async function fetchJkuat(): Promise<Job[]> {
  return parseJkuat(await get(JKUAT, "JKUAT"));
}

export function parseJkuat(html: string, now = Date.now()): Job[] {
  const jobs = new Map<string, Job>();
  for (const [, url, y, mo, rawTitle] of html.matchAll(/<a id="wp-block-file[^"]*" href="([^"]*\/uploads\/(\d{4})\/(\d{2})\/[^"]*)">([^<]+)<\/a>/g)) {
    // Uploaded this month or in the previous two.
    if (now - Date.UTC(Number(y), Number(mo) - 1, 1) > 75 * 86_400_000) continue;
    jobs.set(url, {
      id: `jkuat:${url.split("/uploads/")[1]}`,
      source: "jkuat",
      title: cleanText(rawTitle).replace(/^(final\s+)?(amended\s+)?advert(\s+for)?\s+/i, "").replace(/\s+final$/i, ""),
      company: "Jomo Kenyatta University of Agriculture and Technology (JKUAT)",
      location: "Juja, Kenya",
      description: "University advert (PDF).",
      posted: `${y}-${mo}`,
      url,
    });
  }
  return [...jobs.values()];
}
