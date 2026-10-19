import type { ExtraProfile } from "./types";

/**
 * Candidate profile the AI scores jobs against.
 *
 * Copy this file to src/profile.ts (git-ignored, so your work history stays
 * private) and describe yourself. Leave out contact details. Redeploy after
 * changes: `npm run deploy`.
 */
export const PROFILE = `
Candidate: <role> based in <city, country>. Open to <locations / remote>.

Experience (<N> years, <level>):
- <Job title>, <Company> (<dates>): <key achievements with numbers>
- ...

Skills: <tools, platforms, protocols>

Education: <degree, institution, year>. <certifications>

Target roles: <titles you want>. Not looking for: <roles, seniority or fields to score low>.
`.trim();

/**
 * Optional: other people whose matches go to the same Telegram chat, each
 * alert headed by their label. Only jobs mentioning one of their keywords are
 * scored for them, so the request budget barely moves. See ExtraProfile in
 * src/types.ts; an example entry:
 *
 *   {
 *     key: "sam",
 *     label: "🌱 For Sam",
 *     profile: `Candidate: agronomist based in Nakuru, Kenya ...`,
 *     scoring: `- 9-10: ...\n- 7-8: ...\n- 5-6: ...\n- 3-4: ...\n- 1-2: ...`,
 *     pay: `- Entry-level agronomist (0-2 years): 30,000-50,000\n- ...`,
 *     keywords: ["agronomist", "agronomy", "crop"],
 *   }
 */
export const EXTRA_PROFILES: ExtraProfile[] = [];
