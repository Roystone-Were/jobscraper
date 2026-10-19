import { type Env, splitList } from "./types";

/**
 * Whole-word match. Short all-caps keywords ("IT", "ICT") are case-sensitive
 * so "IT Officer" matches but "apply for it" does not.
 */
export function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const caseSensitive = keyword.length <= 3 && keyword === keyword.toUpperCase();
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, caseSensitive ? "" : "i");
}

export interface Settings {
  include: string[];
  exclude: string[];
  paused: boolean;
  aiScoring: boolean;
  minScore: number;
}

type Key = "include_keywords" | "exclude_keywords" | "paused" | "last_run" | "ai_scoring" | "min_score" | "ai_usage" | "source_health";

async function readAll(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

/** Telegram overrides win; otherwise fall back to wrangler.jsonc vars. */
export async function loadSettings(env: Env): Promise<Settings> {
  const s = await readAll(env.DB);
  return {
    include: splitList(s.get("include_keywords") ?? env.INCLUDE_KEYWORDS),
    exclude: splitList(s.get("exclude_keywords") ?? env.EXCLUDE_KEYWORDS),
    paused: s.get("paused") === "1",
    aiScoring: (s.get("ai_scoring") ?? env.AI_SCORING ?? "on") !== "off",
    minScore: Math.min(10, Math.max(1, Number(s.get("min_score") ?? env.MIN_SCORE) || 6)),
  };
}

export async function getSetting(db: D1Database, key: Key): Promise<string | undefined> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value;
}

export async function setSetting(db: D1Database, key: Key, value: string | null): Promise<void> {
  if (value === null) {
    await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }
}
