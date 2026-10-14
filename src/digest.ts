import { getSetting, setSetting } from "./settings";
import { escape, SOURCE_LABELS } from "./telegram";
import type { Env, Job } from "./types";

/** Per-site fetch health, updated every run and reset weekly by the digest. */
export interface SourceHealth {
  /** Last fetch that returned HTTP OK (unix ms). */
  lastOk?: number;
  /** Last fetch that returned at least one job — catches layout changes. */
  lastNonEmpty?: number;
  lastError?: string;
  lastErrorAt?: number;
  /** Counters since the last digest. */
  ok: number;
  fail: number;
  empty: number;
}
export type Health = Partial<Record<Job["source"], SourceHealth>>;

const DAY = 86_400_000;

/** Task names look like "jobwebkenya", "linkedin:IT support" or "myjobmag:query". */
export function sourceOfTask(name: string): Job["source"] {
  const base = name.split(":")[0];
  return (base === "myjobmag" ? "myjobmag-ke" : base) as Job["source"];
}

export async function recordHealth(
  db: D1Database,
  now: number,
  outcomes: { source: Job["source"]; jobs?: number; error?: string }[],
): Promise<void> {
  const health = JSON.parse((await getSetting(db, "source_health")) ?? "{}") as Health;
  for (const o of outcomes) {
    const h = (health[o.source] ??= { ok: 0, fail: 0, empty: 0 });
    if (o.error !== undefined) {
      h.fail++;
      h.lastError = o.error.slice(0, 160);
      h.lastErrorAt = now;
    } else {
      h.ok++;
      h.lastOk = now;
      if (o.jobs) h.lastNonEmpty = now;
      else h.empty++;
    }
  }
  await setSetting(db, "source_health", JSON.stringify(health));
}

const ago = (t: number | undefined, now: number) => {
  if (!t) return "never";
  const h = Math.round((now - t) / 3_600_000);
  return h < 1 ? "just now" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export async function buildDigest(env: Env, now = Date.now()): Promise<string> {
  const week = now - 7 * DAY;
  const prevWeek = now - 14 * DAY;
  const { results } = await env.DB
    .prepare(
      `SELECT source,
              SUM(first_seen >= ?1) AS this_week,
              SUM(first_seen >= ?2 AND first_seen < ?1) AS last_week,
              SUM(notified_at >= ?1) AS alerts,
              MAX(first_seen) AS last_new
         FROM seen_jobs GROUP BY source`,
    )
    .bind(week, prevWeek)
    .all<{ source: Job["source"]; this_week: number; last_week: number; alerts: number; last_new: number }>();
  const stats = new Map(results.map((r) => [r.source, r]));
  const health = JSON.parse((await getSetting(env.DB, "source_health")) ?? "{}") as Health;

  const lines: string[] = [];
  let problems = 0;
  let totalJobs = 0;
  let totalAlerts = 0;

  for (const [source, label] of Object.entries(SOURCE_LABELS) as [Job["source"], string][]) {
    const s = stats.get(source);
    const h = health[source];
    const jobs = s?.this_week ?? 0;
    totalJobs += jobs;
    totalAlerts += s?.alerts ?? 0;

    let icon = "✅";
    const notes: string[] = [];
    if (!h?.lastOk || now - h.lastOk > DAY) {
      icon = "❌";
      notes.push(`not loading since ${ago(h?.lastOk, now)}${h?.lastError ? `: ${escape(h.lastError)}` : ""}`);
    } else if (!h.lastNonEmpty || now - h.lastNonEmpty > DAY) {
      icon = "⚠️";
      notes.push(`loads but 0 jobs found since ${ago(h.lastNonEmpty, now)} (layout may have changed)`);
    } else if (jobs === 0) {
      icon = "⚠️";
      notes.push("no new jobs this week");
    }
    // LinkedIn is expected to be rate-limited part of the time; only flag heavy failure.
    if (h && h.ok + h.fail > 0) {
      const failRate = h.fail / (h.ok + h.fail);
      if (failRate > (source === "linkedin" ? 0.8 : 0.3)) {
        if (icon === "✅") icon = "⚠️";
        notes.push(`${Math.round(failRate * 100)}% of checks failed`);
      }
    }
    if (icon !== "✅") problems++;

    const trend = s?.last_week ? ` (prev week ${s.last_week})` : "";
    lines.push(
      `${icon} <b>${escape(label)}</b>: ${jobs} jobs${trend} · ${s?.alerts ?? 0} alerts · last new ${ago(s?.last_new, now)}` +
        (notes.length ? `\n      ↳ ${notes.join("; ")}` : ""),
    );
  }

  return [
    "📊 <b>Weekly job-site report</b>",
    `${totalJobs} new jobs found · ${totalAlerts} sent to you`,
    problems ? `⚠️ ${problems} site(s) need attention` : "All sites working.",
    "",
    ...lines,
  ].join("\n");
}

/** Monday digest: send, then reset the weekly counters. */
export async function sendWeeklyDigest(env: Env, send: (html: string) => Promise<void>): Promise<void> {
  await send(await buildDigest(env));
  const health = JSON.parse((await getSetting(env.DB, "source_health")) ?? "{}") as Health;
  for (const h of Object.values(health)) if (h) Object.assign(h, { ok: 0, fail: 0, empty: 0 });
  await setSetting(env.DB, "source_health", JSON.stringify(health));
}
