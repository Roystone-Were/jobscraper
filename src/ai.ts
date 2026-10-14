import { PROFILE } from "./profile";
import type { Job } from "./types";

/**
 * Gemma 4 26B (MoE, ~4B active): good judgement for the price. At roughly
 * 1k tokens per job the Workers AI free allowance covers ~1,000 jobs/day.
 */
export const MODEL = "@cf/google/gemma-4-26b-a4b-it";

export interface Score {
  score: number;
  reason: string;
}

const SYSTEM = `You screen job ads for one candidate and rate how worth applying each one is.

${PROFILE}

Scoring (integer 1-10):
- 9-10: core target role, experience level fits (needs <= 4 years), in Kenya or remote open to Kenya.
- 7-8: strong fit with a minor gap (one missing tool, slightly different focus).
- 5-6: related IT role that is a stretch (e.g. mostly software development, data, or a level above).
- 3-4: weak link to the candidate's skills.
- 1-2: unrelated field, senior/manager level, or on-site outside Kenya.
Job ads may be short; judge mainly from the title, company and any details given. Do not invent requirements.
If one ad lists several vacancies, score the best-matching one and name it in the reason.
Reason: one short sentence (max 20 words) saying why, written to the candidate ("you").`;

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10 },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
};

/** `full` sends the whole job text (second look) instead of the feed summary. */
export async function scoreJob(ai: Ai, job: Job, full = false): Promise<Score> {
  const body = full && job.details ? job.details.slice(0, 3000) : job.description?.slice(0, 1200);
  const ad = [
    `Title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    job.deadline && `Deadline: ${job.deadline}`,
    body && `Details: ${body}`,
  ]
    .filter(Boolean)
    .join("\n");

  const out = (await ai.run(MODEL as Parameters<Ai["run"]>[0], {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: ad },
    ],
    response_format: { type: "json_schema", json_schema: { name: "job_score", schema: SCHEMA, strict: true } },
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0, // same job, same score
    max_completion_tokens: 120,
  } as never)) as unknown;

  return parseScore(out);
}

/** Accepts the Workers AI shapes seen in practice: {response}, OpenAI-style {choices}. */
export function parseScore(out: unknown): Score {
  const o = out as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  let raw: unknown = o?.response ?? o?.choices?.[0]?.message?.content ?? out;
  if (typeof raw === "string") raw = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const r = raw as Partial<Score>;
  const score = Math.round(Number(r.score));
  if (!Number.isFinite(score) || score < 1 || score > 10) throw new Error(`bad AI score: ${JSON.stringify(raw)}`);
  return { score, reason: String(r.reason ?? "").slice(0, 200) };
}
