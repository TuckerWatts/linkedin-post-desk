import type { Account } from "./accounts";
import { one, q } from "./db";
import { UserError } from "./errors";
import { explain, type ErrorKind } from "./explain";
import { cleanDeckTitle, cleanSlides } from "./slides";
import { nextSlot, slotTimes } from "./slots";
import type { Workspace } from "./workspace";

export type PostStatus = "draft" | "revise" | "planned" | "publishing" | "posted" | "failed" | "rejected";

export type Slide = { kind: "cover" | "point" | "end"; title: string; body?: string; quote?: string; quoteLabel?: string };

export type Post = {
  id: string;
  workspace_id: string;
  account_id: string | null;
  status: PostStatus;
  topic: string;
  body: string;
  note: string | null;
  format: "text" | "document";
  doc_title: string | null;
  slides: Slide[] | null;
  attachment_id: string | null;
  attachment_name?: string | null;
  suggested_for: string | null;
  scheduled_for: string | null;
  posted_at: string | null;
  linkedin_urn: string | null;
  url: string | null;
  error: string | null;
  error_kind: ErrorKind | null;
  attempts: number;
  share_note: string | null;
  reshare_account_id: string | null;
  reshare_delay_min: number;
  reshare_status: "none" | "pending" | "resharing" | "done" | "failed" | "skipped";
  reshare_at: string | null;
  reshare_urn: string | null;
  reshare_error: string | null;
  reshare_error_kind: ErrorKind | null;
  source: string;
  created_at: string;
  updated_at: string;
  /** Set only on posts sent to the dashboard (see forDashboard): why it or its reshare didn't go out, in plain words. */
  problem?: string | null;
  reshare_problem?: string | null;
};

export type Comment = {
  id: string; post_id: string; linkedin_id: string; author_urn: string | null; author_name: string | null;
  text: string; commented_at: string | null; replied: boolean;
};

const POST_COLS = `p.*, a.filename AS attachment_name`;

/**
 * A post as the dashboard receives it: any problem explained in plain words, and the technical error messages
 * removed, so they never reach the browser. They stay in the database and server logs for whoever runs the app.
 */
export function forDashboard(p: Post, accounts: Account[]): Post {
  const find = (id: string | null) => accounts.find((a) => a.id === id) ?? null;
  return {
    ...p,
    problem: explain("post", p, find(p.account_id)),
    reshare_problem: explain("reshare", p, find(p.reshare_account_id)),
    error: null,
    reshare_error: null,
  };
}

export function listPosts(workspaceId: string) {
  return q<Post>(
    `SELECT ${POST_COLS} FROM posts p LEFT JOIN attachments a ON a.id = p.attachment_id
     WHERE p.workspace_id = $1 AND (p.status <> 'rejected' OR p.updated_at > now() - interval '30 days')
     ORDER BY COALESCE(p.scheduled_for, p.suggested_for, p.created_at)`,
    [workspaceId],
  );
}

export function getPost(id: string, workspaceId: string) {
  return one<Post>(
    `SELECT ${POST_COLS} FROM posts p LEFT JOIN attachments a ON a.id = p.attachment_id WHERE p.id = $1 AND p.workspace_id = $2`,
    [id, workspaceId],
  );
}

export function listComments(workspaceId: string) {
  return q<Comment>(
    `SELECT c.* FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.workspace_id = $1 ORDER BY c.commented_at DESC NULLS LAST`,
    [workspaceId],
  );
}

/** Times already taken by planned or suggested posts, for picking the next slot. */
export async function takenTimes(workspaceId: string, exceptId?: string): Promise<Date[]> {
  const rows = await q<{ t: string }>(
    `SELECT COALESCE(scheduled_for, suggested_for) AS t FROM posts
     WHERE workspace_id = $1 AND status IN ('draft','revise','planned','publishing') AND ($2::uuid IS NULL OR id <> $2)
       AND COALESCE(scheduled_for, suggested_for) IS NOT NULL`,
    [workspaceId, exceptId ?? null],
  );
  return rows.map((r) => new Date(r.t));
}

export type NewDraft = {
  topic: string; body: string; shareNote?: string | null; accountId?: string | null; reshareAccountId?: string | null;
  format?: "text" | "document"; docTitle?: string | null; slides?: Slide[] | null; attachmentId?: string | null;
  source?: string; suggestedFor?: Date | null;
};

/** Adds a draft with a suggested time: 2-3 days after the last planned post, within the workspace's posting windows. */
export async function createDraft(ws: Pick<Workspace, "id" | "timezone" | "posting_windows">, d: NewDraft): Promise<Post> {
  const workspaceId = ws.id;
  const seed = `${d.topic}:${Date.now()}:${Math.random()}`;
  const when = d.suggestedFor ?? nextSlot(await takenTimes(workspaceId), seed, ws.timezone, new Date(), slotTimes(ws.posting_windows));
  const defaults = await one<{ org: string | null; person: string | null }>(
    `SELECT (SELECT id FROM accounts WHERE workspace_id=$1 AND is_default ORDER BY created_at LIMIT 1) AS org,
            (SELECT id FROM accounts WHERE workspace_id=$1 AND is_reshare_default ORDER BY created_at LIMIT 1) AS person`,
    [workspaceId],
  );
  const row = await one<Post>(
    `INSERT INTO posts (workspace_id, account_id, reshare_account_id, topic, body, share_note, format, doc_title, slides, attachment_id,
                        source, suggested_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [workspaceId, d.accountId ?? defaults?.org ?? null, d.reshareAccountId ?? defaults?.person ?? null, d.topic, d.body,
     d.shareNote ?? null, d.format ?? "text", d.docTitle ?? null, d.slides ? JSON.stringify(d.slides) : null,
     d.attachmentId ?? null, d.source ?? "manual", when.toISOString()],
  );
  return row!;
}

/** Fields the UI may change directly. */
const EDITABLE = ["topic", "body", "note", "share_note", "account_id", "reshare_account_id", "doc_title", "url", "reshare_delay_min"] as const;
type Editable = (typeof EDITABLE)[number];

export type PostAction =
  | { action: "edit"; fields: Partial<Record<Editable, unknown>> }
  | { action: "approve"; scheduledFor: string; body?: string; accountId?: string | null }
  | { action: "unplan" }
  | { action: "revise"; note: string; body?: string }
  | { action: "reject" }
  | { action: "restore" }
  | { action: "markPosted"; url?: string | null }
  | { action: "markReshared" }
  | { action: "retry" }
  /** Save hand-edited carousel slides (the PDF is then built from them), or null to make it a text post. */
  | { action: "setSlides"; slides: Slide[] | null; docTitle?: string | null };

const LINKEDIN_URL = /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i;

/** Why a post in this state can't be approved, in plain words (never the internal status name). */
const CANT_APPROVE: Partial<Record<PostStatus, string>> = {
  publishing: "This post is being published right now.",
  posted: "This post is already on LinkedIn.",
  rejected: "This post was rejected. Restore it first.",
};

export async function applyAction(id: string, workspaceId: string, a: PostAction): Promise<Post | null> {
  const post = await getPost(id, workspaceId);
  if (!post) return null;
  const set = (sql: string, params: unknown[]) =>
    one<Post>(`UPDATE posts SET ${sql}, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`, [id, workspaceId, ...params]);

  switch (a.action) {
    case "edit": {
      const cols: string[] = []; const vals: unknown[] = [];
      for (const k of EDITABLE) {
        if (!(k in a.fields)) continue;
        let v = a.fields[k];
        if (k === "url" && v && !LINKEDIN_URL.test(String(v))) throw new UserError("Use a linkedin.com link.");
        if (k === "reshare_delay_min") v = Math.max(0, Math.min(7 * 24 * 60, Number(v) || 0));
        cols.push(`${k} = $${vals.length + 3}`); vals.push(v === "" ? null : v);
      }
      if (!cols.length) return post;
      return set(cols.join(", "), vals);
    }
    case "approve": {
      const when = new Date(a.scheduledFor);
      if (Number.isNaN(when.getTime())) throw new UserError("Pick a valid date and time.");
      if (!["draft", "revise", "failed", "planned"].includes(post.status)) throw new UserError(CANT_APPROVE[post.status] ?? "This post can't be approved.");
      if (post.format === "document" && !post.slides?.length && !post.attachment_id) {
        throw new UserError("Add slides or upload a PDF before approving this carousel.");
      }
      return set(
        `status = 'planned', scheduled_for = $3, body = COALESCE($4, body), account_id = COALESCE($5, account_id), error = NULL, error_kind = NULL, attempts = 0`,
        [when.toISOString(), a.body ?? null, a.accountId ?? null],
      );
    }
    case "unplan":
      if (post.status !== "planned") throw new UserError("Only planned posts can go back to review.");
      return set(`status = 'draft', suggested_for = scheduled_for, scheduled_for = NULL`, []);
    case "revise":
      return set(`status = 'revise', note = $3, body = COALESCE($4, body)`, [a.note, a.body ?? null]);
    case "reject":
      return set(`status = 'rejected'`, []);
    case "restore":
      return set(`status = 'draft'`, []);
    case "markPosted": {
      if (a.url && !LINKEDIN_URL.test(a.url)) throw new UserError("Use a linkedin.com link.");
      return set(
        `status = 'posted', posted_at = COALESCE(posted_at, now()), url = COALESCE($3, url), error = NULL, error_kind = NULL,
         reshare_status = CASE WHEN reshare_account_id IS NOT NULL AND reshare_status = 'none' THEN 'pending' ELSE reshare_status END,
         reshare_at = COALESCE(reshare_at, now() + make_interval(mins => reshare_delay_min))`,
        [a.url ?? null],
      );
    }
    case "setSlides": {
      if (!["draft", "revise", "failed", "planned"].includes(post.status)) throw new UserError(CANT_APPROVE[post.status] ?? "This post can't be changed now.");
      if (a.slides === null) return set(`format = 'text'`, []); // the slides are kept, in case it's made a carousel again
      const slides = cleanSlides(a.slides);
      const deck = cleanDeckTitle(a.docTitle ?? post.doc_title, post.topic);
      // attachment_id = NULL: the PDF is built from these slides from now on, replacing any uploaded one.
      return set(`format = 'document', slides = $3, doc_title = $4, attachment_id = NULL`, [JSON.stringify(slides), deck]);
    }
    case "markReshared":
      return set(`reshare_status = 'done', reshare_error = NULL, reshare_error_kind = NULL`, []);
    case "retry":
      if (post.status === "failed") return set(`status = 'planned', error = NULL, error_kind = NULL, attempts = 0`, []);
      if (post.reshare_status === "failed") return set(`reshare_status = 'pending', reshare_error = NULL, reshare_error_kind = NULL, reshare_at = now(), reshare_attempts = 0`, []);
      return post;
  }
}
