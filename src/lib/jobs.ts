// Scheduled work. Each job is safe to run often and concurrently (rows are claimed with SKIP LOCKED).
import { accessTokenFor } from "./accounts";
import { buildCarouselPdf } from "./carousel";
import { one, q } from "./db";
import { draftFromShipped, generateDrafts } from "./drafting";
import { env } from "./env";
import { createPost, getComments, LinkedInError, postUrl, uploadDocument } from "./linkedin";
import type { Post } from "./posts";
import { getWorkspace } from "./workspace";

export const JOBS = ["publish", "reshare", "comments", "weekly-draft", "autofill"] as const;
export type JobName = (typeof JOBS)[number];

const API_ACCOUNT = `a.access_token_enc IS NOT NULL AND a.urn NOT LIKE 'manual:%'`;

function errText(e: unknown): string {
  if (e instanceof LinkedInError) return `${e.message}: ${e.body.slice(0, 300)}`;
  return e instanceof Error ? e.message : String(e);
}

async function ensureDocument(p: Post & { author_urn: string }, token: string): Promise<string | null> {
  if (p.format !== "document") return null;
  let attachmentId = p.attachment_id;
  if (!attachmentId) {
    if (!p.slides?.length) throw new Error("Document post has no PDF and no slides to build one from.");
    const bytes = await buildCarouselPdf(p.slides, { label: p.doc_title || p.topic });
    const att = await one<{ id: string }>(
      `INSERT INTO attachments (workspace_id, filename, content_type, size_bytes, data) VALUES ($1,$2,'application/pdf',$3,$4) RETURNING id`,
      [p.workspace_id, `${(p.doc_title || p.topic).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`, bytes.length, Buffer.from(bytes)]);
    attachmentId = att!.id;
    await q("UPDATE posts SET attachment_id = $2 WHERE id = $1", [p.id, attachmentId]);
  }
  const file = await one<{ data: Buffer }>("SELECT data FROM attachments WHERE id = $1", [attachmentId]);
  return uploadDocument(token, p.author_urn, new Uint8Array(file!.data));
}

async function publishDue(): Promise<string> {
  const claimed = await q<Post & { author_urn: string }>(
    `UPDATE posts p SET status = 'publishing', attempts = attempts + 1, updated_at = now()
     FROM accounts a
     WHERE p.account_id = a.id AND ${API_ACCOUNT}
       AND p.id IN (SELECT id FROM posts WHERE status = 'planned' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT 5 FOR UPDATE SKIP LOCKED)
     RETURNING p.*, a.urn AS author_urn`);
  const results: string[] = [];
  for (const p of claimed) {
    try {
      const token = await accessTokenFor(p.account_id!);
      const docUrn = await ensureDocument(p, token);
      const urn = await createPost(token, {
        author: p.author_urn,
        text: p.body,
        document: docUrn ? { urn: docUrn, title: p.doc_title || p.topic } : undefined,
      });
      await q(
        `UPDATE posts SET status = 'posted', posted_at = now(), linkedin_urn = $2, url = $3, error = NULL,
           reshare_status = CASE WHEN reshare_account_id IS NOT NULL THEN 'pending' ELSE 'none' END,
           reshare_at = now() + make_interval(mins => reshare_delay_min), updated_at = now()
         WHERE id = $1`, [p.id, urn, postUrl(urn)]);
      results.push(`posted ${p.topic}`);
    } catch (e) {
      const final = p.attempts >= 3 || (e instanceof LinkedInError && [400, 401, 403, 422].includes(e.status));
      await q(`UPDATE posts SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [p.id, final ? "failed" : "planned", errText(e)]);
      results.push(`${final ? "failed" : "will retry"} ${p.topic}: ${errText(e)}`);
    }
  }
  return results.join("\n") || "nothing due";
}

async function reshareDue(): Promise<string> {
  const claimed = await q<Post & { person_urn: string }>(
    `UPDATE posts p SET reshare_status = 'done', updated_at = now()
     FROM accounts a
     WHERE p.reshare_account_id = a.id AND ${API_ACCOUNT}
       AND p.id IN (SELECT id FROM posts WHERE reshare_status = 'pending' AND reshare_at <= now() AND linkedin_urn IS NOT NULL
                    ORDER BY reshare_at LIMIT 5 FOR UPDATE SKIP LOCKED)
     RETURNING p.*, a.urn AS person_urn`);
  const results: string[] = [];
  for (const p of claimed) {
    try {
      const token = await accessTokenFor(p.reshare_account_id!);
      const urn = await createPost(token, { author: p.person_urn, text: p.share_note || "", reshareOf: p.linkedin_urn! });
      await q(`UPDATE posts SET reshare_urn = $2, reshare_error = NULL WHERE id = $1`, [p.id, urn]);
      results.push(`reshared ${p.topic}`);
    } catch (e) {
      await q(`UPDATE posts SET reshare_status = 'failed', reshare_error = $2 WHERE id = $1`, [p.id, errText(e)]);
      results.push(`reshare failed ${p.topic}: ${errText(e)}`);
    }
  }
  return results.join("\n") || "nothing to reshare";
}

async function syncComments(): Promise<string> {
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
  return `${added} new comment(s) across ${posts.length} post(s)`;
}

async function weeklyDraft(): Promise<string> {
  const ws = await getWorkspace();
  if (!env.anthropic.apiKey) return "skipped: ANTHROPIC_API_KEY not set";
  if (!ws.github_repo || !env.github.token) return "skipped: GitHub repo or token not set";
  const post = await draftFromShipped(ws);
  return post ? `drafted "${post.topic}"` : "nothing post-worthy this week";
}

/** Keeps the pipeline full: at least 6 upcoming drafts or planned posts. */
async function autofill(): Promise<string> {
  const ws = await getWorkspace();
  if (!env.anthropic.apiKey) return "skipped: ANTHROPIC_API_KEY not set";
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE workspace_id=$1 AND status IN ('draft','revise','planned')`, [ws.id]);
  const missing = Math.min(3, 6 - (r?.n ?? 0));
  if (missing <= 0) return "pipeline full";
  const drafts = await generateDrafts(ws, missing);
  return `added ${drafts.length} draft(s)`;
}

const RUNNERS: Record<JobName, () => Promise<string>> = {
  publish: publishDue,
  reshare: reshareDue,
  comments: syncComments,
  "weekly-draft": weeklyDraft,
  autofill,
};

export async function runJob(name: JobName): Promise<{ ok: boolean; summary: string }> {
  const run = await one<{ id: number }>("INSERT INTO job_runs (job) VALUES ($1) RETURNING id", [name]);
  try {
    const summary = await RUNNERS[name]();
    await q("UPDATE job_runs SET finished_at = now(), ok = true, summary = $2 WHERE id = $1", [run!.id, summary]);
    return { ok: true, summary };
  } catch (e) {
    const summary = errText(e);
    await q("UPDATE job_runs SET finished_at = now(), ok = false, summary = $2 WHERE id = $1", [run!.id, summary]);
    return { ok: false, summary };
  }
}
