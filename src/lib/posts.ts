import { one, q } from "./db";
import { nextSlot } from "./slots";

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
  attempts: number;
  share_note: string | null;
  reshare_account_id: string | null;
  reshare_delay_min: number;
  reshare_status: "none" | "pending" | "done" | "failed" | "skipped";
  reshare_at: string | null;
  reshare_urn: string | null;
  reshare_error: string | null;
  source: string;
  source_refs: string[];
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string; post_id: string; linkedin_id: string; author_urn: string | null; author_name: string | null;
  text: string; commented_at: string | null; replied: boolean;
};

const POST_COLS = `p.*, a.filename AS attachment_name`;

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
  source?: string; sourceRefs?: string[]; suggestedFor?: Date | null;
};

export async function createDraft(workspaceId: string, tz: string, d: NewDraft): Promise<Post> {
  const seed = `${d.topic}:${Date.now()}:${Math.random()}`;
  const when = d.suggestedFor ?? nextSlot(await takenTimes(workspaceId), seed, tz);
  const defaults = await one<{ org: string | null; person: string | null }>(
    `SELECT (SELECT id FROM accounts WHERE workspace_id=$1 AND is_default ORDER BY created_at LIMIT 1) AS org,
            (SELECT id FROM accounts WHERE workspace_id=$1 AND is_reshare_default ORDER BY created_at LIMIT 1) AS person`,
    [workspaceId],
  );
  const row = await one<Post>(
    `INSERT INTO posts (workspace_id, account_id, reshare_account_id, topic, body, share_note, format, doc_title, slides, attachment_id,
                        source, source_refs, suggested_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [workspaceId, d.accountId ?? defaults?.org ?? null, d.reshareAccountId ?? defaults?.person ?? null, d.topic, d.body,
     d.shareNote ?? null, d.format ?? "text", d.docTitle ?? null, d.slides ? JSON.stringify(d.slides) : null,
     d.attachmentId ?? null, d.source ?? "manual", d.sourceRefs ?? [], when.toISOString()],
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
  | { action: "retry" };

const LINKEDIN_URL = /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i;

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
        if (k === "url" && v && !LINKEDIN_URL.test(String(v))) throw new Error("Use a linkedin.com link.");
        if (k === "reshare_delay_min") v = Math.max(0, Math.min(7 * 24 * 60, Number(v) || 0));
        cols.push(`${k} = $${vals.length + 3}`); vals.push(v === "" ? null : v);
      }
      if (!cols.length) return post;
      return set(cols.join(", "), vals);
    }
    case "approve": {
      const when = new Date(a.scheduledFor);
      if (Number.isNaN(when.getTime())) throw new Error("Pick a valid date and time.");
      if (!["draft", "revise", "failed", "planned"].includes(post.status)) throw new Error(`Can't approve a ${post.status} post.`);
      return set(
        `status = 'planned', scheduled_for = $3, body = COALESCE($4, body), account_id = COALESCE($5, account_id), error = NULL, attempts = 0`,
        [when.toISOString(), a.body ?? null, a.accountId ?? null],
      );
    }
    case "unplan":
      if (post.status !== "planned") throw new Error("Only planned posts can go back to review.");
      return set(`status = 'draft', suggested_for = scheduled_for, scheduled_for = NULL`, []);
    case "revise":
      return set(`status = 'revise', note = $3, body = COALESCE($4, body)`, [a.note, a.body ?? null]);
    case "reject":
      return set(`status = 'rejected'`, []);
    case "restore":
      return set(`status = 'draft'`, []);
    case "markPosted": {
      if (a.url && !LINKEDIN_URL.test(a.url)) throw new Error("Use a linkedin.com link.");
      return set(
        `status = 'posted', posted_at = COALESCE(posted_at, now()), url = COALESCE($3, url), error = NULL,
         reshare_status = CASE WHEN reshare_account_id IS NOT NULL AND reshare_status = 'none' THEN 'pending' ELSE reshare_status END,
         reshare_at = COALESCE(reshare_at, now() + make_interval(mins => reshare_delay_min))`,
        [a.url ?? null],
      );
    }
    case "markReshared":
      return set(`reshare_status = 'done', reshare_error = NULL`, []);
    case "retry":
      if (post.status === "failed") return set(`status = 'planned', error = NULL, attempts = 0`, []);
      if (post.reshare_status === "failed") return set(`reshare_status = 'pending', reshare_error = NULL, reshare_at = now()`, []);
      return post;
  }
}
