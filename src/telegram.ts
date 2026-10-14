import type { Job } from "./types";

export const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const SOURCE_LABELS: Record<Job["source"], string> = {
  "myjobmag-ke": "MyJobMag",
  brightermonday: "BrighterMonday",
  jobwebkenya: "JobWebKenya",
  oyk: "Opportunities for Young Kenyans",
  corporatestaffing: "Corporate Staffing",
  untalent: "UNTalent",
  impactpool: "Impactpool",
  linkedin: "LinkedIn",
};

export function formatJob(job: Job): string {
  const label = SOURCE_LABELS[job.source];
  const lines = [`<b>${escape(job.title)}</b>`];
  if (job.score != null) {
    lines.push(`🎯 <b>${job.score}/10</b>${job.scoreReason ? ` · <i>${escape(job.scoreReason)}</i>` : ""}`);
  }
  if (job.company) lines.push(`🏢 ${escape(job.company)}`);
  if (job.location) lines.push(`📍 ${escape(job.location)}`);
  if (job.posted) lines.push(`🕒 ${escape(job.posted)}`);
  if (job.description) lines.push("", escape(job.description.slice(0, 300)));
  lines.push("", `<a href="${escape(job.url)}">Open on ${label}</a>`);
  return lines.join("\n");
}

type Button = { text: string; callback_data?: string; url?: string };
export type Keyboard = { inline_keyboard: Button[][] };

/** Buttons under each alert. `key` is the job's short_key. */
export function jobKeyboard(key: string, url: string, saved = false): Keyboard {
  return {
    inline_keyboard: [
      [
        saved
          ? { text: "⭐ Saved (undo)", callback_data: `unsave:${key}` }
          : { text: "⭐ Save", callback_data: `save:${key}` },
        { text: "👎 Not interested", callback_data: `hide:${key}` },
      ],
      [{ text: "Open job ↗", url }],
    ],
  };
}

/** Calls a Bot API method and returns its `result`. */
export async function tg<T = unknown>(token: string, method: string, body: object): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} -> HTTP ${res.status}: ${data.description}`);
  return data.result;
}

export async function sendTelegram(
  token: string,
  chatId: string,
  html: string,
  keyboard?: Keyboard,
): Promise<void> {
  await tg(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  });
}
