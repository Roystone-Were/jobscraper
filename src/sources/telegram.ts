import { decodeEntities, formatNairobi, type Job, USER_AGENT } from "../types";

/**
 * Public Kenyan job channels, read through Telegram's web preview
 * (t.me/s/<channel>, the latest ~20 posts). None is IT-only; the AI filters.
 * Checked 2026-10-14: active, original employer ads, not reposts of boards we scrape.
 */
export const TELEGRAM_CHANNELS = ["jobsupdatesochyberry", "sunlitcentrekenya", "campusbizke"];

export async function fetchTelegram(channel: string): Promise<Job[]> {
  // A private/group/missing channel redirects instead of serving a preview.
  const res = await fetch(`https://t.me/s/${channel}`, { headers: { "User-Agent": USER_AGENT }, redirect: "manual" });
  if (res.status !== 200) throw new Error(`Telegram ${channel} -> HTTP ${res.status}`);
  return parseTelegram(await res.text());
}

const textOf = (html: string) =>
  decodeEntities(
    html
      .replace(/<i class="emoji"[\s\S]*?<\/i>/g, "") // emoji images
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

export function parseTelegram(html: string): Job[] {
  const jobs: Job[] = [];
  for (const post of html.split('class="tgme_widget_message_wrap').slice(1)) {
    const permalink = post.match(/<a class="tgme_widget_message_date" href="(https:\/\/t\.me\/([^"/]+)\/(\d+))"/);
    const body = post.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!permalink || !body) continue; // image-only posts have no text

    const text = textOf(body[1]);
    if (text.length < 40) continue;

    // First line with real words becomes the title; strip decoration.
    const title = (text.split("\n").find((l) => /[a-z]{3}/i.test(l)) ?? text)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")
      .slice(0, 140);
    const posted = post.match(/<time datetime="([^"]+)"/);

    jobs.push({
      id: `telegram:${permalink[2].toLowerCase()}/${permalink[3]}`,
      source: "telegram",
      title,
      company: `@${permalink[2]}`,
      description: text.slice(0, 1200),
      details: text.slice(0, 3000),
      posted: posted ? formatNairobi(new Date(posted[1])) : undefined,
      url: permalink[1],
    });
  }
  return jobs;
}
