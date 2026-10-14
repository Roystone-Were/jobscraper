import { buildDaily, buildDigest } from "./digest";
import { getSetting, loadSettings, type Settings, setSetting } from "./settings";
import { escape, jobKeyboard, SOURCE_LABELS, tg } from "./telegram";
import type { Env, Job } from "./types";
import { splitList } from "./types";

/** Shown by /help and registered with Telegram's command menu. */
export const COMMANDS = [
  ["status", "What the scraper is doing"],
  ["keywords", "Show title keywords"],
  ["add", "Add keywords: /add python, cloud"],
  ["remove", "Remove keywords: /remove cloud"],
  ["exclude", "Skip titles with words: /exclude senior"],
  ["unexclude", "Stop skipping words: /unexclude senior"],
  ["resetkeywords", "Back to the default keyword lists"],
  ["minscore", "Min AI score to alert: /minscore 7"],
  ["ai", "AI scoring on/off: /ai off"],
  ["saved", "Jobs you saved"],
  ["today", "Last 24 h round-up (also sent 7 am)"],
  ["digest", "Site health report (also sent Mondays)"],
  ["pause", "Stop alerts"],
  ["resume", "Start alerts again"],
  ["help", "List commands"],
] as const;

interface Update {
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

interface JobRow {
  title: string;
  company: string | null;
  url: string;
  source: Job["source"];
  status: string | null;
}

export async function handleUpdate(env: Env, update: Update): Promise<void> {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  // Private bot: ignore everyone except the configured chat.
  if (String(chatId) !== env.TELEGRAM_CHAT_ID) return;

  if (update.callback_query) return handleButton(env, update.callback_query);
  const text = update.message?.text?.trim();
  if (text?.startsWith("/")) return handleCommand(env, text);
}

async function reply(env: Env, html: string) {
  await tg(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function handleCommand(env: Env, text: string) {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.slice(1).split("@")[0].toLowerCase();
  const args = splitList(rest.join(" "));
  const settings = await loadSettings(env);

  switch (cmd) {
    case "start":
    case "help":
      return reply(env, ["<b>Job Scraper commands</b>", ...COMMANDS.map(([c, d]) => `/${c} — ${escape(d)}`)].join("\n"));

    case "status":
      return reply(env, await statusText(env, settings));

    case "keywords":
      return reply(env, keywordsText(settings.include, settings.exclude));

    case "add":
    case "remove":
    case "exclude":
    case "unexclude": {
      if (!args.length) return reply(env, `Usage: /${cmd} word1, word2`);
      const key = cmd === "add" || cmd === "remove" ? "include_keywords" : "exclude_keywords";
      const current = key === "include_keywords" ? settings.include : settings.exclude;
      const adding = cmd === "add" || cmd === "exclude";
      const lower = (s: string) => s.toLowerCase();
      const next = adding
        ? [...current, ...args.filter((a) => !current.some((c) => lower(c) === lower(a)))]
        : current.filter((c) => !args.some((a) => lower(a) === lower(c)));
      await setSetting(env.DB, key, next.join(", "));
      const s = await loadSettings(env);
      return reply(env, `✅ Updated.\n\n${keywordsText(s.include, s.exclude)}`);
    }

    case "resetkeywords":
      await setSetting(env.DB, "include_keywords", null);
      await setSetting(env.DB, "exclude_keywords", null);
      return reply(env, `↩️ Back to defaults.\n\n${keywordsText(splitList(env.INCLUDE_KEYWORDS), splitList(env.EXCLUDE_KEYWORDS))}`);

    case "minscore": {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 1 || n > 10) return reply(env, `Current minimum: <b>${settings.minScore}/10</b>
Usage: /minscore 7 (1-10)`);
      await setSetting(env.DB, "min_score", String(n));
      return reply(env, `✅ You'll get jobs the AI scores <b>${n}/10</b> or higher.`);
    }

    case "ai": {
      const v = rest[0]?.toLowerCase();
      if (v !== "on" && v !== "off") return reply(env, `AI scoring is <b>${settings.aiScoring ? "on" : "off"}</b>. Usage: /ai on or /ai off`);
      await setSetting(env.DB, "ai_scoring", v);
      return reply(env, v === "on"
        ? "🤖 AI scoring on: jobs are rated against your CV."
        : "AI scoring off: alerts use title keywords only (/keywords).");
    }

    case "today":
      return reply(env, await buildDaily(env, settings.minScore));

    case "digest":
      return reply(env, await buildDigest(env));

    case "pause":
      await setSetting(env.DB, "paused", "1");
      return reply(env, "⏸ Alerts paused. Jobs found while paused are skipped, not saved up. /resume to restart.");

    case "resume":
      await setSetting(env.DB, "paused", null);
      return reply(env, "▶️ Alerts resumed.");

    case "saved": {
      const { results } = await env.DB
        .prepare("SELECT title, company, url, source, status FROM seen_jobs WHERE status = 'saved' ORDER BY notified_at DESC LIMIT 25")
        .all<JobRow>();
      if (!results.length) return reply(env, "No saved jobs yet. Tap ⭐ Save under an alert.");
      return reply(
        env,
        [`<b>⭐ Saved jobs (${results.length})</b>`, ...results.map((r, i) =>
          `${i + 1}. <a href="${escape(r.url)}">${escape(r.title)}</a>${r.company ? ` · ${escape(r.company)}` : ""}`)].join("\n"),
      );
    }

    default:
      return reply(env, "Unknown command. /help lists them.");
  }
}

function keywordsText(include: string[], exclude: string[]) {
  return [
    `<b>Title keywords</b> (${include.length}) — job boards only, not LinkedIn:`,
    include.length ? escape(include.join(", ")) : "<i>none — every job matches</i>",
    "",
    `<b>Excluded</b> (${exclude.length}):`,
    exclude.length ? escape(exclude.join(", ")) : "<i>none</i>",
  ].join("\n");
}

async function statusText(env: Env, settings: Settings) {
  const paused = settings.paused;
  const day = 86_400_000;
  const eat = 3 * 3_600_000; // Nairobi is UTC+3 all year
  const todayStart = Math.floor((Date.now() + eat) / day) * day - eat;

  const [lastRunRaw, today, saved, aiUsageRaw] = await Promise.all([
    getSetting(env.DB, "last_run"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM seen_jobs WHERE notified_at >= ?").bind(todayStart).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM seen_jobs WHERE status = 'saved'").first<{ n: number }>(),
    getSetting(env.DB, "ai_usage"),
  ]);

  const lines = [`<b>Status:</b> ${paused ? "⏸ paused" : "▶️ running every 10 min (hourly 11 pm–7 am)"}`];
  if (lastRunRaw) {
    const r = JSON.parse(lastRunRaw) as { at: number; fetched: number; errors: string[] };
    const ago = Math.round((Date.now() - r.at) / 60_000);
    lines.push(`<b>Last check:</b> ${ago <= 0 ? "just now" : `${ago} min ago`} · ${r.fetched} jobs scanned`);
    if (r.errors.length) lines.push(`<b>Last errors:</b>\n${r.errors.map((e) => `• ${escape(e.slice(0, 120))}`).join("\n")}`);
  }
  lines.push(`<b>Alerts today:</b> ${today?.n ?? 0}`, `<b>Saved:</b> ${saved?.n ?? 0}`);
  const aiUsage = JSON.parse(aiUsageRaw ?? "{}") as { day?: string; n?: number };
  const todayKey = new Date(Date.now() + eat).toISOString().slice(0, 10);
  lines.push(settings.aiScoring
    ? `<b>AI scoring:</b> on · alerts at ${settings.minScore}/10+ · ${aiUsage.day === todayKey ? aiUsage.n : 0}/${Number(env.AI_DAILY_LIMIT) || 600} jobs scored today`
    : "<b>AI scoring:</b> off (title keywords only)");
  lines.push(`<b>Sources:</b> ${Object.values(SOURCE_LABELS).join(", ")}`);
  return lines.join("\n");
}

async function handleButton(env: Env, q: NonNullable<Update["callback_query"]>) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const [action, key] = (q.data ?? "").split(":");
  const msg = q.message;
  const row = key
    ? await env.DB.prepare("SELECT title, company, url, source, status FROM seen_jobs WHERE short_key = ?").bind(key).first<JobRow>()
    : null;

  if (!row || !msg) {
    await tg(token, "answerCallbackQuery", { callback_query_id: q.id, text: "Job not found" });
    return;
  }

  const setStatus = (status: string | null) =>
    env.DB.prepare("UPDATE seen_jobs SET status = ? WHERE short_key = ?").bind(status, key).run();
  const target = { chat_id: msg.chat.id, message_id: msg.message_id };

  switch (action) {
    case "save":
    case "unsave":
      await setStatus(action === "save" ? "saved" : null);
      await tg(token, "editMessageReplyMarkup", { ...target, reply_markup: jobKeyboard(key, row.url, action === "save") });
      await tg(token, "answerCallbackQuery", { callback_query_id: q.id, text: action === "save" ? "Saved ⭐ — see /saved" : "Removed from saved" });
      return;

    case "hide":
      await setStatus("hidden");
      // Collapse the alert to one line so the chat stays readable.
      await tg(token, "editMessageText", {
        ...target,
        text: `👎 <s>${escape(row.title)}</s>${row.company ? ` · ${escape(row.company)}` : ""}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: `unhide:${key}` }]] },
      });
      await tg(token, "answerCallbackQuery", { callback_query_id: q.id, text: "Hidden" });
      return;

    case "unhide": {
      await setStatus(null);
      const lines = [`<b>${escape(row.title)}</b>`];
      if (row.company) lines.push(`🏢 ${escape(row.company)}`);
      lines.push("", `<a href="${escape(row.url)}">Open on ${SOURCE_LABELS[row.source] ?? row.source}</a>`);
      await tg(token, "editMessageText", {
        ...target,
        text: lines.join("\n"),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: jobKeyboard(key, row.url),
      });
      await tg(token, "answerCallbackQuery", { callback_query_id: q.id });
      return;
    }

    default:
      await tg(token, "answerCallbackQuery", { callback_query_id: q.id });
  }
}
