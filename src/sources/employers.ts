import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

/**
 * Employers with Nairobi offices whose careers boards have public JSON APIs.
 * Checked 2026-10-15; each returned HTTP 200 with Kenya jobs (or, for
 * Africa's Talking and Poa Internet, a live board worth watching). Only jobs
 * located in Kenya (or listing Kenya as a location) are kept.
 */
type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "bamboohr" | "pinpoint" | "workable";
export const EMPLOYERS: { name: string; ats: Ats; slug: string }[] = [
  { name: "One Acre Fund", ats: "greenhouse", slug: "oneacrefund" },
  { name: "Moniepoint", ats: "greenhouse", slug: "moniepoint" },
  { name: "Jumia", ats: "greenhouse", slug: "jumia" },
  { name: "Educate!", ats: "greenhouse", slug: "educate" },
  { name: "M-KOPA", ats: "ashby", slug: "m-kopa" },
  { name: "IDinsight", ats: "ashby", slug: "idinsight" },
  { name: "Sun King", ats: "pinpoint", slug: "sunking" },
  { name: "Amref Health Africa", ats: "smartrecruiters", slug: "AmrefHealthAfrica4" },
  { name: "Apollo Agriculture", ats: "lever", slug: "apolloagriculture" },
  { name: "CIMMYT", ats: "workable", slug: "cimmyt-1" },
  { name: "Cellulant", ats: "bamboohr", slug: "cellulant" },
  { name: "GiveDirectly", ats: "bamboohr", slug: "givedirectly" },
  { name: "Busara Center", ats: "bamboohr", slug: "busara" },
  { name: "Africa's Talking", ats: "bamboohr", slug: "africastalking" },
  { name: "Poa Internet", ats: "bamboohr", slug: "poainternet" },
  // Added 2026-10-19. Tala and Koko had no Kenya jobs then but hire in Nairobi.
  { name: "Thunes", ats: "greenhouse", slug: "thunes" },
  { name: "Tala", ats: "lever", slug: "tala" },
  { name: "Koko Networks", ats: "lever", slug: "kokonetworks" },
];

const KENYA = /kenya|nairobi|mombasa|kisumu|nakuru|eldoret|thika|kiambu|machakos|homa ?bay|\bKE\b/i;

const API: Record<Ats, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?country=ke&limit=100`,
  bamboohr: (s) => `https://${s}.bamboohr.com/careers/list`,
  pinpoint: (s) => `https://${s}.pinpointhq.com/postings.json`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
};

export async function fetchEmployer(e: (typeof EMPLOYERS)[number]): Promise<Job[]> {
  const res = await fetch(API[e.ats](e.slug), { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${e.name} (${e.ats}) -> HTTP ${res.status}`);
  return parseEmployer(e, await res.json());
}

const when = (d?: string | number) => {
  if (d == null) return undefined;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? undefined : formatNairobi(t);
};

/* eslint-disable @typescript-eslint/no-explicit-any -- each ATS has its own JSON shape */
export function parseEmployer(e: (typeof EMPLOYERS)[number], data: any): Job[] {
  const rows: { id: string; title: string; location: string; team?: string; posted?: string; url: string }[] = [];

  switch (e.ats) {
    case "greenhouse":
      for (const j of data.jobs ?? [])
        rows.push({ id: String(j.id), title: j.title, location: j.location?.name ?? "", posted: when(j.first_published ?? j.updated_at), url: j.absolute_url });
      break;
    case "lever":
      for (const j of data ?? [])
        rows.push({
          id: j.id,
          title: j.text,
          location: [j.categories?.location, ...(j.categories?.allLocations ?? []), j.country].filter(Boolean).join(", "),
          team: j.categories?.team,
          posted: when(j.createdAt),
          url: j.hostedUrl,
        });
      break;
    case "ashby":
      for (const j of data.jobs ?? [])
        rows.push({
          id: j.id,
          title: j.title,
          // Kenya is sometimes only a secondary location.
          location: [j.location, ...(j.secondaryLocations ?? []).map((l: any) => l.location ?? l), j.address?.postalAddress?.addressCountry]
            .filter(Boolean)
            .join(", "),
          team: j.department ?? j.team,
          posted: when(j.publishedAt),
          url: j.jobUrl,
        });
      break;
    case "smartrecruiters":
      for (const j of data.content ?? [])
        rows.push({
          id: j.id,
          title: j.name,
          location: [j.location?.fullLocation, j.location?.city, j.location?.country].filter(Boolean).join(", "),
          team: j.department?.label,
          posted: when(j.releasedDate),
          url: `https://jobs.smartrecruiters.com/${e.slug}/${j.id}`,
        });
      break;
    case "bamboohr":
      for (const j of data.result ?? [])
        rows.push({
          id: String(j.id),
          title: j.jobOpeningName,
          location: [j.location?.city, j.location?.state, j.location?.country].filter(Boolean).join(", "),
          team: j.departmentLabel,
          url: `https://${e.slug}.bamboohr.com/careers/${j.id}`,
        });
      break;
    case "pinpoint":
      for (const j of data.data ?? [])
        rows.push({
          id: String(j.id),
          title: j.title,
          location: [j.location?.city, j.location?.name].filter(Boolean).join(", "),
          team: j.job?.department?.name ?? j.job?.department,
          url: j.url,
        });
      break;
    case "workable":
      for (const j of data.jobs ?? [])
        rows.push({
          id: j.shortcode,
          title: j.title,
          location: [j.city, j.country, ...(j.locations ?? []).map((l: any) => l.countryCode)].filter(Boolean).join(", "),
          team: j.department,
          posted: when(j.published_on),
          url: j.url,
        });
      break;
  }

  return rows
    .filter((r) => r.title && KENYA.test(r.location))
    .map((r) => ({
      id: `employer:${e.slug}:${r.id}`,
      source: "employer" as const,
      title: cleanText(r.title),
      company: e.name,
      location: r.location,
      description: r.team ? `Department: ${r.team}` : undefined,
      posted: r.posted,
      url: r.url,
    }));
}
