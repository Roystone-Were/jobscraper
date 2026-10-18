import { PROFILE } from "./profile";
import { salaryEstimate, type Confidence } from "./salary";
import type { Job } from "./types";

/**
 * Gemma 4 26B (MoE, ~4B active): good judgement for the price. At roughly
 * 1k tokens per job the Workers AI free allowance covers ~1,000 jobs/day.
 */
export const MODEL = "@cf/google/gemma-4-26b-a4b-it";

export interface Score {
  score: number;
  reason: string;
  /** Pay exactly as the ad states it, or "" — verified against the ad text by the caller. */
  salary?: string;
  /** Market pay estimate when the ad states none, labelled as such; see salaryEstimate(). */
  estimate?: string;
}

const SYSTEM = `You screen job ads for one candidate and rate how worth applying each one is.

${PROFILE}

Scoring (integer 1-10):
- 9-10: core target role, experience level fits (needs <= 4 years), in Kenya or remote open to Kenya.
- 7-8: strong fit with a minor gap (one missing tool, slightly different focus).
- 5-6: related IT role that is a stretch (e.g. mostly software development, data, or a level above).
- 3-4: weak link to the candidate's skills.
- 1-2: unrelated field, senior/manager level, or on-site outside Kenya.
If a large part of the duties is work the candidate is not looking for (e.g. half the duties), score at most 5, even when the rest fits.
Job ads may be short; judge mainly from the title, company and any details given. Do not invent requirements.
If one ad lists several vacancies, score the best-matching one and name it in the reason.
Reason: one short sentence (max 20 words) saying why, written to the candidate ("you").
Salary: the pay exactly as the ad states it (amount, currency, period), e.g. "KES 100,000–150,000 per month". Empty string if the ad does not state pay; put guesses in the estimate fields, not here.
estimate_min / estimate_max: the typical gross monthly pay in KES for this role at this employer, rounded to the nearest 5,000. Fill these for every job in Kenya (or remote for Kenya) whose ad states no pay, whatever its score. Start from these Kenyan market ranges, then adjust for seniority and employer size:
- Internship or attachment: 10,000-30,000
- Entry-level IT support / helpdesk (0-2 years), small firm: 30,000-60,000
- IT officer / technician (2-5 years), small or mid-sized firm: 50,000-100,000
- The same level at a bank, insurer, telco, multinational or international NGO: 90,000-180,000
- Network or systems engineer / administrator (3-5 years), large employer: 120,000-250,000
- Senior, lead or manager: 200,000-450,000
Set both to 0 only if the ad states pay, the job is outside Kenya, or it is a UN post. Otherwise always give your best estimate, even for short ads.
estimate_confidence: "high" if the employer is well known (or its type and size are clear) and the role and seniority are clear; "medium" if one of those is unclear; "low" if the ad is short or vague and the employer is unknown.`;

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10 },
    reason: { type: "string" },
    salary: { type: "string" },
    estimate_min: { type: "integer" },
    estimate_max: { type: "integer" },
    estimate_confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["score", "reason", "salary", "estimate_min", "estimate_max", "estimate_confidence"],
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
    max_completion_tokens: 160,
  } as never)) as unknown;

  // The model overrates its own confidence, so cap it by what the ad gives it.
  const maxConfidence = !job.company ? "low" : (body?.length ?? 0) < 200 ? "medium" : "high";
  return parseScore(out, maxConfidence);
}

/** Accepts the Workers AI shapes seen in practice: {response}, OpenAI-style {choices}. */
export function parseScore(out: unknown, maxConfidence: Confidence = "high"): Score {
  const o = out as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  let raw: unknown = o?.response ?? o?.choices?.[0]?.message?.content ?? out;
  if (typeof raw === "string") raw = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const r = raw as Partial<Score> & { estimate_min?: unknown; estimate_max?: unknown; estimate_confidence?: unknown };
  const score = Math.round(Number(r.score));
  if (!Number.isFinite(score) || score < 1 || score > 10) throw new Error(`bad AI score: ${JSON.stringify(raw)}`);
  return {
    score,
    reason: String(r.reason ?? "").slice(0, 200),
    salary: typeof r.salary === "string" ? r.salary : undefined,
    estimate: salaryEstimate(Number(r.estimate_min), Number(r.estimate_max), r.estimate_confidence, maxConfidence),
  };
}
