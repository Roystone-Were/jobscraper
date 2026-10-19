import { cleanText, formatNairobi, type Job, USER_AGENT } from "../types";

// NGO and UN jobs in Kenya (country 131) via the JSON API, which needs an
// approved appname (RELIEFWEB_APPNAME). The RSS answers Cloudflare's IPs with a
// bot challenge (HTTP 202, empty body); the API doesn't.
const API = "https://api.reliefweb.int/v2/jobs";

export const RELIEFWEB_FILTERS = {
  // Career category Information and Communications Technology.
  ict: { field: "career_categories.id", value: 6866 },
  // Theme Agriculture: fisheries and aquaculture projects (EXTRA_PROFILES) land here.
  agriculture: { field: "theme.id", value: 4587 },
};

interface ReliefWebJob {
  id: string;
  fields: {
    title?: string;
    body?: string;
    url_alias?: string;
    url?: string;
    source?: { name?: string }[];
    city?: { name?: string }[];
    date?: { created?: string; closing?: string };
  };
}

export async function fetchReliefWeb(appname: string | undefined, filter: { field: string; value: number }): Promise<Job[]> {
  if (!appname) throw new Error("ReliefWeb -> RELIEFWEB_APPNAME not set");
  const res = await fetch(`${API}?appname=${encodeURIComponent(appname)}`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({
      limit: 30,
      sort: ["date.created:desc"],
      fields: { include: ["title", "body", "url", "url_alias", "source.name", "city.name", "date.created", "date.closing"] },
      filter: { operator: "AND", conditions: [{ field: "country.id", value: 131 }, filter] },
    }),
  });
  if (!res.ok) throw new Error(`ReliefWeb -> HTTP ${res.status}`);
  return parseReliefWeb((await res.json()) as { data?: ReliefWebJob[] });
}

export function parseReliefWeb(json: { data?: ReliefWebJob[] }): Job[] {
  const jobs: Job[] = [];
  for (const { id, fields: f } of json.data ?? []) {
    const url = f.url_alias ?? f.url;
    if (!f.title || !url) continue;

    // The body is Markdown.
    const text = (f.body ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#*_`>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Closing dates are midnight UTC of the day; treat them as 23:59 Nairobi.
    const closes = f.date?.closing?.slice(0, 10);
    const at = closes ? Date.parse(`${closes}T20:59:00Z`) : NaN;
    const city = f.city?.[0]?.name;

    jobs.push({
      id: `reliefweb:${id}`,
      source: "reliefweb",
      title: cleanText(f.title),
      company: f.source?.[0]?.name ? cleanText(f.source[0].name) : undefined,
      location: city ? `${city}, Kenya` : "Kenya",
      description: text.slice(0, 1200) || undefined,
      details: text.slice(0, 3000) || undefined,
      posted: f.date?.created ? formatNairobi(new Date(f.date.created)) : undefined,
      deadline: closes,
      deadlineAt: Number.isNaN(at) ? undefined : at,
      url,
    });
  }
  return jobs;
}
