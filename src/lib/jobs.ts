// Scheduled work. Each job is safe to run often and concurrently (rows are claimed with SKIP LOCKED).
import { accessTokenFor } from "./accounts";
import { one, q } from "./db";
import { generateDrafts } from "./drafting";
import { env } from "./env";
import { getComments, LinkedInError } from "./linkedin";
import { errText, publishDue, reshareDue, type RunResult } from "./publish";
import { getWorkspace } from "./workspace";

export const JOBS = ["publish", "reshare", "comments", "autofill"] as const;
export type JobName = (typeof JOBS)[number];

const API_ACCOUNT = `a.access_token_enc IS NOT NULL AND a.urn NOT LIKE 'manual:%'`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const DRAFTING_OFF = "Off: drafting isn't set up yet.";

async function syncComments(): Promise<RunResult> {
  const posts = await q<{ id: string; linkedin_urn: string; account_id: string }>(
    `SELECT p.id, p.linkedin_urn, p.account_id FROM posts p JOIN accounts a ON a.id = p.account_id
     WHERE p.status = 'posted' AND p.linkedin_urn IS NOT NULL AND p.posted_at > now() - interval '30 days'
       AND a.kind = 'organization' AND ${API_ACCOUNT}`);
  let added = 0;
  for (const p of posts) {
    try {
      const token = await accessTokenFor(p.account_id);
      for (const c of await getComments(token, p.linkedin_urn)) {
        const r = await q(
          `INSERT INTO comments (post_id, linkedin_id, author_urn, text, commented_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (linkedin_id) DO UPDATE SET text = EXCLUDED.text RETURNING (xmax = 0) AS inserted`,
          [p.id, c.id, c.actor ?? null, c.text, c.time ? new Date(c.time).toISOString() : null]);
        if ((r[0] as { inserted?: boolean })?.inserted) added++;
      }
    } catch (e) {
      // Comment reading needs r_organization_social_feed; skip quietly if the app doesn't have it yet.
      if (!(e instanceof LinkedInError && e.status === 403)) throw e;
    }
  }
  return {
    log: `${added} new comment(s) across ${posts.length} post(s)`,
    note: added ? `${plural(added, "new comment", "new comments")}.` : "No new comments.",
  };
}

/** Keeps the pipeline full: at least 6 upcoming drafts or planned posts. */
async function autofill(): Promise<RunResult> {
  const ws = await getWorkspace();
  if (!env.anthropic.apiKey) return { log: "skipped: ANTHROPIC_API_KEY not set", note: DRAFTING_OFF };
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE workspace_id=$1 AND status IN ('draft','revise','planned')`, [ws.id]);
  const missing = Math.min(3, 6 - (r?.n ?? 0));
  if (missing <= 0) return { log: "pipeline full", note: "There are already enough drafts and planned posts." };
  const drafts = await generateDrafts(ws, missing);
  return { log: `added ${drafts.length} draft(s)`, note: `Added ${plural(drafts.length, "draft", "drafts")} for review.` };
}

const RUNNERS: Record<JobName, () => Promise<RunResult>> = {
  publish: () => publishDue(),
  reshare: () => reshareDue(),
  comments: syncComments,
  autofill,
};

/** What the dashboard says when a run fails. The technical error goes to the server log and job_runs.summary. */
export const JOB_FAILED_NOTE = "Didn't finish. It'll try again automatically.";

/** summary: technical log, for operators (scheduler output, server logs). note: plain words, for the dashboard. */
export async function runJob(name: JobName): Promise<{ ok: boolean; summary: string; note: string }> {
  const run = await one<{ id: number }>("INSERT INTO job_runs (job) VALUES ($1) RETURNING id", [name]);
  try {
    const { log, note } = await RUNNERS[name]();
    await q("UPDATE job_runs SET finished_at = now(), ok = true, summary = $2, note = $3 WHERE id = $1", [run!.id, log, note]);
    return { ok: true, summary: log, note };
  } catch (e) {
    const summary = errText(e);
    console.error(`[job ${name}] failed:`, e);
    await q("UPDATE job_runs SET finished_at = now(), ok = false, summary = $2, note = $3 WHERE id = $1",
      [run!.id, summary, JOB_FAILED_NOTE]);
    return { ok: false, summary, note: JOB_FAILED_NOTE };
  }
}
