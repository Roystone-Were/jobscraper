/**
 * Pay information for alerts, always labelled with where it came from:
 * - "advertised": stated in the ad (structured field or the ad text)
 * - "CSG n civil service scale": looked up from the official SRC table
 * - "UNTalent estimate": UNTalent's own figure for UN posts
 * - "AI estimate": the scoring model's market guess, used only when none of
 *   the above is available, and marked "≈" so it never passes for an offer.
 */

/**
 * National civil service basic monthly pay, KSh, by CSG grade. Source: SRC
 * Fourth Remuneration Review 2025/26–2028/29 Phase II (letter of 17 July 2026,
 * effective 1 July 2026), as reported by educationnewshub.co.ke. Basic pay
 * only; allowances come on top.
 */
const CSG_BASIC: Record<number, [number, number]> = {
  3: [312_085, 576_120],
  4: [202_080, 400_040],
  5: [164_600, 320_140],
  6: [120_440, 202_080],
  7: [96_140, 144_300],
  8: [63_870, 105_150],
  9: [49_910, 73_050],
  10: [45_210, 61_020],
  11: [38_210, 49_910],
  12: [32_410, 42_280],
  13: [29_210, 36_960],
  14: [24_350, 30_250],
  15: [23_130, 28_260],
  16: [22_040, 26_510],
  17: [20_640, 23_710],
};

const n = (x: number) => Math.round(x).toLocaleString("en-US");

export function kesRange(min?: number, max?: number): string | undefined {
  if (!min && !max) return undefined;
  return min && max && max !== min ? `KES ${n(min)}–${n(max)}` : `KES ${n((min || max)!)}`;
}

const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/**
 * The AI's monthly KES range, if plausible (0 means it declined to guess).
 * Its confidence is capped at `cap`, which the caller sets from how much the
 * ad says (no employer named → low).
 */
export function salaryEstimate(min: number, max: number, confidence: unknown, cap: Confidence = "high"): string | undefined {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (min < 10_000 || max < min || max > 1_000_000 || max > min * 4) return undefined;
  const r5k = (x: number) => Math.round(x / 5_000) * 5_000;
  const level = Math.min(Math.max(0, CONFIDENCE.indexOf(confidence as Confidence)), CONFIDENCE.indexOf(cap));
  return `≈ ${kesRange(r5k(min), r5k(max))}/month gross · AI estimate, ${CONFIDENCE[level]} confidence`;
}

/** "CSG 8" anywhere in the ad → the official basic-pay band. */
export function salaryFromCsg(text: string): string | undefined {
  const m = text.match(/\bCSG\s?-?\s?(\d{1,2})\b/i);
  const band = m ? CSG_BASIC[Number(m[1])] : undefined;
  return band ? `${kesRange(...band)}/month basic · CSG ${m![1]} civil service scale (2026)` : undefined;
}

/**
 * The official band for an ad's CSG grade. A PDF advert may list posts on
 * several grades; with no way to tell which post the AI picked, `singleOnly`
 * returns a band only when the text names one grade.
 */
export function csgBand(text: string, singleOnly: boolean): string | undefined {
  if (singleOnly && new Set([...text.matchAll(/\bCSG\s?-?\s?(\d{1,2})\b/gi)].map((m) => Number(m[1]))).size > 1) return undefined;
  return salaryFromCsg(text);
}

/** schema.org JobPosting pay, with sanity checks: some sites fill it with junk. */
export function salaryFromJsonLd(post: {
  baseSalary?: { currency?: string; value?: { value?: unknown; minValue?: unknown; maxValue?: unknown; unitText?: string } };
  estimatedSalary?: unknown;
  salaryCurrency?: string;
}): string | undefined {
  const v = post.baseSalary?.value;
  const cur = (post.baseSalary?.currency || "").toUpperCase();
  const min = Number(v?.minValue) || Number(v?.value) || 0;
  const max = Number(v?.maxValue) || 0;
  const unit = (v?.unitText || "MONTH").toLowerCase();
  // Plausible monthly KES pay only (e.g. JobWebKenya fills in 1,866–3,733).
  // eTalent leaves the currency blank on Kenyan jobs; treat blank as KES.
  if ((cur === "KES" || cur === "") && unit.includes("month") && min >= 10_000) return `${kesRange(min, max)}/month (advertised)`;

  const est = Number(post.estimatedSalary);
  if (est > 0 && post.salaryCurrency) return `≈ ${post.salaryCurrency} ${n(est)}/month (UNTalent estimate)`;
  return undefined;
}

/**
 * The AI reports pay "as stated in the ad". Accept it only if every number it
 * gives (4+ digits, e.g. 100,000 or 100k → 100000) actually appears in the text.
 */
export function verifiedAiSalary(salary: string | undefined, adText: string): string | undefined {
  const s = salary?.trim();
  if (!s || s.length > 80 || !/\d/.test(s)) return undefined;
  const digits = (x: string) => x.replace(/[,\s]/g, "");
  const source = digits(adText.toLowerCase());
  const numbers = (s.toLowerCase().match(/\d[\d,\s]*(k)?/g) ?? [])
    .map((x) => digits(x))
    .map((x) => (x.endsWith("k") ? `${x.slice(0, -1)}000` : x))
    .filter((x) => x.length >= 4);
  if (!numbers.length) return undefined;
  const ok = numbers.every((x) => source.includes(x) || source.includes(`${x.slice(0, -3)}k`));
  return ok ? `${s} (advertised)` : undefined;
}
