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
