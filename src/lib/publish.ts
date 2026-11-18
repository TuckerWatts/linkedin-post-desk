// Publishing planned posts and resharing them to LinkedIn, including recovery when a worker dies (serverless
// timeout, deploy, crash) between claiming the work and recording LinkedIn's answer.
//
// Posts and reshares follow the same protocol. A claim moves the row to an in-flight state ('publishing' /
// 'resharing') with a fresh token and timestamp. Just before the create request goes out, a "sent" timestamp is set,
// but only if the worker still holds the claim. A claim older than STALE_AFTER_MS is treated as abandoned:
//   - nothing was sent yet           -> queued again and retried (counts toward MAX_ATTEMPTS)
//   - the request may have gone out  -> 'failed' with a note to check LinkedIn, because retrying could post twice
// A slow worker whose claim was recovered can't send or overwrite anything, because every write after the claim
// checks the token. The one exception is a success, which is always recorded since it's what happened.
import { accessTokenFor, flagReconnect, NotConnectedError } from "./accounts";
import { buildCarouselPdf } from "./carousel";
import { one, q } from "./db";
import { UserError } from "./errors";
import type { ErrorKind } from "./explain";
import { createPost, isNetworkError, LinkedInError, mayHaveCreated, postUrl, uploadDocument, type PostInput } from "./linkedin";
import { publisherName } from "./names";
import type { Post } from "./posts";

export const MAX_ATTEMPTS = 3;
/** Well past the 60s serverless limit and the slowest normal run (document upload polling, several posts). */
export const STALE_AFTER_MS = 15 * 60 * 1000;
const BATCH = 5;

// Technical details stored when recovery ends a stale claim. The dashboard explains them in plain words (explain.ts).
export const STOPPED_BEFORE_SENDING = "The run stopped before anything was sent to LinkedIn.";
export const STOPPED_WHILE_SENDING = "The run stopped after the request was sent to LinkedIn, before its answer was saved.";
export const STOPPED_UNTRACKED = "The run stopped partway, and it didn't record whether the request was sent.";

/** author_name: the publishing account's name (heads carousel slides). */
export type ClaimedPost = Post & { author_urn: string; author_name: string; publish_claim: string };
export type ClaimedReshare = Post & { person_urn: string; reshare_claim: string };

/** An in-flight post or reshare whose claim has gone stale. claim is null for rows claimed before claims were tracked. */
export type StaleClaim = {
  id: string;
  topic: string;
  attempts: number;
  claim: string | null;
  sent_at: string | Date | null;
};

export interface PublishStore {
  /** Posts in 'publishing' whose claim is older than olderThanMs. */
  findStale(olderThanMs: number): Promise<StaleClaim[]>;
  /** Atomically moves up to `limit` due posts on API accounts to 'publishing' with a fresh claim token. */
  claimDue(limit: number): Promise<ClaimedPost[]>;
  /** Marks the create request as about to be sent. False if the claim is no longer held. */
  markSending(id: string, claim: string): Promise<boolean>;
  /** Records a successful post. Unconditional: if LinkedIn accepted it, that is the truth. */
  markPosted(id: string, urn: string, url: string): Promise<void>;
  /** Ends a claim with 'planned' (retry) or 'failed'. False if the claim is no longer held. */
  release(id: string, claim: string | null, status: "planned" | "failed", error: string, kind: ErrorKind): Promise<boolean>;
}

export interface ReshareStore {
  /** Reshares in 'resharing' whose claim is older than olderThanMs. */
  findStale(olderThanMs: number): Promise<StaleClaim[]>;
  /** Atomically moves up to `limit` due reshares on API accounts to 'resharing' with a fresh claim token. */
  claimDue(limit: number): Promise<ClaimedReshare[]>;
  /** Marks the reshare request as about to be sent. False if the claim is no longer held. */
  markSending(id: string, claim: string): Promise<boolean>;
  /** Records a successful reshare. Unconditional, like PublishStore.markPosted. */
  markDone(id: string, urn: string): Promise<void>;
  /** Ends a claim with 'pending' (retry) or 'failed'. False if the claim is no longer held. */
  release(id: string, claim: string | null, status: "pending" | "failed", error: string, kind: ErrorKind): Promise<boolean>;
}

type LinkedInDeps = {
  accessTokenFor: (accountId: string) => Promise<string>;
  createPost: (token: string, input: PostInput) => Promise<string>;
  /** Called when LinkedIn rejects the account's token, so the dashboard asks for a reconnect instead of a Retry. */
  flagReconnect: (accountId: string) => Promise<void>;
  staleAfterMs?: number;
};

export type PublishDeps = LinkedInDeps & {
  store: PublishStore;
  /** Returns the LinkedIn document URN for document posts, null for text posts. */
  prepareDocument: (p: ClaimedPost, token: string) => Promise<string | null>;
};

export type ReshareDeps = LinkedInDeps & { store: ReshareStore };

export function errText(e: unknown): string {
  if (e instanceof LinkedInError) return e.body ? `${e.message}: ${e.body.slice(0, 300)}` : e.message;
  if (!(e instanceof Error)) return String(e);
  // fetch() failures say only "fetch failed"; the useful part ("other side closed", "ENOTFOUND ...") is the cause.
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message ? `${e.message} (${cause.message})` : e.message;
}

type Interruption = "retry" | "gave up" | "maybe live";

/** What happened to work whose worker disappeared. Only retry when nothing can have reached LinkedIn. */
function interruption(p: StaleClaim): Interruption {
  // No claim token: claimed by code that didn't record progress, so we can't know whether it was sent.
  if (!p.claim || p.sent_at != null) return "maybe live";
  return p.attempts >= MAX_ATTEMPTS ? "gave up" : "retry";
}

type Outcome<S> = { status: S; error: string; kind: ErrorKind };

function recoveryOutcome<S extends string>(p: StaleClaim, retry: S): Outcome<S | "failed"> {
  const i = interruption(p);
  if (i === "retry") return { status: retry, error: STOPPED_BEFORE_SENDING, kind: "interrupted" };
  if (i === "gave up") return { status: "failed", error: STOPPED_BEFORE_SENDING, kind: "interrupted" };
  return { status: "failed", error: p.claim ? STOPPED_WHILE_SENDING : STOPPED_UNTRACKED, kind: "maybe_live" };
}

export const recoveryFor = (p: StaleClaim) => recoveryOutcome(p, "planned" as const);
export const reshareRecoveryFor = (p: StaleClaim) => recoveryOutcome(p, "pending" as const);

/** What sort of problem a failed create was, for the dashboard (see explain.ts). */
export function errorKind(e: unknown, sending: boolean): ErrorKind {
  if (sending && mayHaveCreated(e)) return "maybe_live";
  if (e instanceof NotConnectedError) return "reconnect";
  if (e instanceof UserError) return "plain";
  if (e instanceof LinkedInError) {
    if (e.status === 401) return "reconnect";
    if (e.status === 403) return "forbidden";
    if (e.status === 429 || e.status >= 500) return "unavailable";
    if (e.status >= 400) return "rejected";
  }
  if (isNetworkError(e)) return "unreachable";
  return "other";
}

/**
 * What a run did. `log` is the technical record for whoever operates the app (scheduler output, job_runs.summary);
 * `note` is a short plain sentence for the dashboard.
 */
export type RunResult = { log: string; note: string };

class Tally {
  lines: string[] = [];
  done = 0;
  retrying = 0;
  attention = 0;
  constructor(private verb: string, private one: string, private many: string, private idle: RunResult) {}
  result(): RunResult {
    const parts: string[] = [];
    if (this.done) parts.push(`${this.verb} ${this.done} ${this.done === 1 ? this.one : this.many}`);
    if (this.retrying) parts.push(`${this.retrying} will retry automatically`);
    if (this.attention) parts.push(`${this.attention} need${this.attention === 1 ? "s" : ""} your attention in To do`);
    return {
      log: this.lines.join("\n") || this.idle.log,
      note: parts.length ? `${parts.join(". ")}.` : this.idle.note,
    };
  }
}

async function recover<S extends string>(
  stale: StaleClaim[], label: string, tally: Tally,
  release: (p: StaleClaim, o: Outcome<S>) => Promise<boolean>,
  decide: (p: StaleClaim) => Outcome<S>,
): Promise<void> {
  for (const p of stale) {
    const o = decide(p);
    if (!(await release(p, o))) continue; // finished or recovered meanwhile
    const i = interruption(p);
    // A post put back in the queue is usually claimed again by this same run and counted there.
    if (i !== "retry") tally.attention++;
    const what = i === "retry" ? "will retry"
      : i === "gave up" ? `failed after ${p.attempts} attempts` : "failed, may be live on LinkedIn";
    tally.lines.push(`recovered stuck ${label} ${p.topic}: ${what}`);
  }
}

export async function publishDue(deps: PublishDeps = defaultDeps()): Promise<RunResult> {
  const t = new Tally("Posted", "post", "posts", { log: "nothing due", note: "Nothing was due." });
  const { store } = deps;
  await recover(await store.findStale(deps.staleAfterMs ?? STALE_AFTER_MS), "post", t,
    (p, o) => store.release(p.id, p.claim, o.status, o.error, o.kind), recoveryFor);
  const results = t.lines;
  for (const p of await deps.store.claimDue(BATCH)) {
    let urn: string;
    let sending = false;
    try {
      const token = await deps.accessTokenFor(p.account_id!);
      const docUrn = await deps.prepareDocument(p, token);
      if (!(await deps.store.markSending(p.id, p.publish_claim))) {
        results.push(`skipped ${p.topic}: taken over by another run`);
        continue;
      }
      sending = true;
      urn = await deps.createPost(token, {
        author: p.author_urn,
        text: p.body,
        document: docUrn ? { urn: docUrn, title: p.doc_title || p.topic } : undefined,
      });
    } catch (e) {
      const kind = errorKind(e, sending);
      if (kind === "maybe_live") {
        // Retrying could post it twice, so a person checks LinkedIn instead.
        const held = await deps.store.release(p.id, p.publish_claim, "failed", errText(e), kind);
        if (held) t.attention++;
        results.push(`${held ? "failed, may be live on LinkedIn:" : "gave up (taken over)"} ${p.topic}: ${errText(e)}`);
        continue;
      }
      // Retrying can't help when LinkedIn refused the post or the account needs reconnecting.
      const final = p.attempts >= MAX_ATTEMPTS || kind === "reconnect"
        || (e instanceof LinkedInError && [400, 401, 403, 422].includes(e.status));
      const held = await deps.store.release(p.id, p.publish_claim, final ? "failed" : "planned", errText(e), kind);
      if (held) { if (final) t.attention++; else t.retrying++; }
      results.push(`${!held ? "gave up (taken over)" : final ? "failed" : "will retry"} ${p.topic}: ${errText(e)}`);
      if (kind === "reconnect") await deps.flagReconnect(p.account_id!);
      continue;
    }
    try {
      await deps.store.markPosted(p.id, urn, postUrl(urn));
      t.done++;
      results.push(`posted ${p.topic}`);
    } catch (e) {
      t.done++; // it is live; recovery flags it later because the link couldn't be saved
      // Live on LinkedIn but not saved. Leave the claim alone: publish_sent_at is set, so recovery will flag it
      // for a person to check rather than post it again.
      results.push(`posted ${p.topic} (${postUrl(urn)}) but couldn't save it: ${errText(e)}`);
    }
  }
  return t.result();
}

export async function reshareDue(deps: ReshareDeps = defaultReshareDeps()): Promise<RunResult> {
  const t = new Tally("Reshared", "post", "posts", { log: "nothing to reshare", note: "Nothing to reshare." });
  const { store } = deps;
  await recover(await store.findStale(deps.staleAfterMs ?? STALE_AFTER_MS), "reshare", t,
    (p, o) => store.release(p.id, p.claim, o.status, o.error, o.kind), reshareRecoveryFor);
  const results = t.lines;
  for (const p of await deps.store.claimDue(BATCH)) {
    let urn: string;
    let sending = false;
    try {
      const token = await deps.accessTokenFor(p.reshare_account_id!);
      if (!(await deps.store.markSending(p.id, p.reshare_claim))) {
        results.push(`skipped reshare ${p.topic}: taken over by another run`);
        continue;
      }
      sending = true;
      urn = await deps.createPost(token, { author: p.person_urn, text: p.share_note || "", reshareOf: p.linkedin_urn! });
    } catch (e) {
      // As before, any failed reshare waits for a person (no automatic retry). The kind tells the dashboard
      // whether it may have gone through anyway, so that pressing Retry isn't the obvious next step.
      const kind = errorKind(e, sending);
      const held = await deps.store.release(p.id, p.reshare_claim, "failed", errText(e), kind);
      if (held) t.attention++;
      results.push(`${held ? "reshare failed" : "reshare gave up (taken over)"} ${p.topic}: ${errText(e)}`);
      if (kind === "reconnect") await deps.flagReconnect(p.reshare_account_id!);
      continue;
    }
    try {
      await deps.store.markDone(p.id, urn);
      t.done++;
      results.push(`reshared ${p.topic}`);
    } catch (e) {
      t.done++;
      // Live but not saved: reshare_sent_at is set, so recovery will flag it rather than reshare again.
      results.push(`reshared ${p.topic} (${postUrl(urn)}) but couldn't save it: ${errText(e)}`);
    }
  }
  return t.result();
}

// ---- Postgres -------------------------------------------------------------------------------------------------

/** Accounts the app posts as itself (connected, not "post by hand"). */
const apiAccount = (alias: string) => `${alias}.access_token_enc IS NOT NULL AND ${alias}.urn NOT LIKE 'manual:%'`;
const CLEAR_CLAIM = `publish_claim = NULL, publish_claimed_at = NULL, publish_sent_at = NULL`;
const CLEAR_RESHARE_CLAIM = `reshare_claim = NULL, reshare_claimed_at = NULL, reshare_sent_at = NULL`;

export const pgPublishStore: PublishStore = {
  findStale(olderThanMs) {
    // Rows claimed before claims were tracked have no publish_claimed_at; fall back to updated_at.
    return q<StaleClaim>(
      `SELECT id, topic, attempts, publish_claim AS claim, publish_sent_at AS sent_at FROM posts
       WHERE status = 'publishing' AND COALESCE(publish_claimed_at, updated_at) < now() - make_interval(secs => $1)
       ORDER BY COALESCE(publish_claimed_at, updated_at) LIMIT 50`,
      [olderThanMs / 1000]);
  },

  claimDue(limit) {
    return q<ClaimedPost>(
      `UPDATE posts p SET status = 'publishing', attempts = attempts + 1, publish_claim = gen_random_uuid(),
         publish_claimed_at = now(), publish_sent_at = NULL, updated_at = now()
       FROM accounts a
       WHERE p.account_id = a.id
         -- Pick only posts the app publishes itself. Filtering after the LIMIT let overdue "post by hand" posts,
         -- which stay 'planned' until marked posted, fill every slot and stop automatic posts for good.
         AND p.id IN (SELECT d.id FROM posts d JOIN accounts da ON da.id = d.account_id
                      WHERE d.status = 'planned' AND d.scheduled_for <= now() AND ${apiAccount("da")}
                      ORDER BY d.scheduled_for LIMIT $1 FOR UPDATE OF d SKIP LOCKED)
       RETURNING p.*, a.urn AS author_urn, COALESCE(a.display_name, a.name) AS author_name`, [limit]);
  },

  async markSending(id, claim) {
    const r = await q(
      `UPDATE posts SET publish_sent_at = now() WHERE id = $1 AND status = 'publishing' AND publish_claim = $2 RETURNING id`,
      [id, claim]);
    return r.length > 0;
  },

  async markPosted(id, urn, url) {
    await q(
      `UPDATE posts SET status = 'posted', posted_at = now(), linkedin_urn = $2, url = $3, error = NULL, error_kind = NULL, ${CLEAR_CLAIM},
         reshare_status = CASE WHEN reshare_account_id IS NOT NULL THEN 'pending' ELSE 'none' END,
         reshare_at = now() + make_interval(mins => reshare_delay_min), updated_at = now()
       WHERE id = $1`, [id, urn, url]);
  },

  async release(id, claim, status, error, kind) {
    const r = await q(
      `UPDATE posts SET status = $3, error = $4, error_kind = $5, ${CLEAR_CLAIM}, updated_at = now()
       WHERE id = $1 AND status = 'publishing' AND publish_claim IS NOT DISTINCT FROM $2::uuid RETURNING id`,
      [id, claim, status, error, kind]);
    return r.length > 0;
  },
};

export const pgReshareStore: ReshareStore = {
  findStale(olderThanMs) {
    // 'resharing' only exists since claims were tracked, so reshare_claimed_at is always set.
    return q<StaleClaim>(
      `SELECT id, topic, reshare_attempts AS attempts, reshare_claim AS claim, reshare_sent_at AS sent_at FROM posts
       WHERE reshare_status = 'resharing' AND COALESCE(reshare_claimed_at, updated_at) < now() - make_interval(secs => $1)
       ORDER BY COALESCE(reshare_claimed_at, updated_at) LIMIT 50`,
      [olderThanMs / 1000]);
  },

  claimDue(limit) {
    return q<ClaimedReshare>(
      `UPDATE posts p SET reshare_status = 'resharing', reshare_attempts = reshare_attempts + 1,
         reshare_claim = gen_random_uuid(), reshare_claimed_at = now(), reshare_sent_at = NULL, updated_at = now()
       FROM accounts a
       WHERE p.reshare_account_id = a.id
         -- As for posts: only reshares the app makes itself, so reshares done by hand can't use up the batch.
         AND p.id IN (SELECT d.id FROM posts d JOIN accounts da ON da.id = d.reshare_account_id
                      WHERE d.reshare_status = 'pending' AND d.reshare_at <= now() AND d.linkedin_urn IS NOT NULL AND ${apiAccount("da")}
                      ORDER BY d.reshare_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED)
       RETURNING p.*, a.urn AS person_urn`, [limit]);
  },

  async markSending(id, claim) {
    const r = await q(
      `UPDATE posts SET reshare_sent_at = now() WHERE id = $1 AND reshare_status = 'resharing' AND reshare_claim = $2 RETURNING id`,
      [id, claim]);
    return r.length > 0;
  },

  async markDone(id, urn) {
    await q(
      `UPDATE posts SET reshare_status = 'done', reshare_urn = $2, reshare_error = NULL, reshare_error_kind = NULL,
         ${CLEAR_RESHARE_CLAIM}, updated_at = now()
       WHERE id = $1`, [id, urn]);
  },

  async release(id, claim, status, error, kind) {
    const r = await q(
      `UPDATE posts SET reshare_status = $3, reshare_error = $4, reshare_error_kind = $5, ${CLEAR_RESHARE_CLAIM}, updated_at = now()
       WHERE id = $1 AND reshare_status = 'resharing' AND reshare_claim IS NOT DISTINCT FROM $2::uuid RETURNING id`,
      [id, claim, status, error, kind]);
    return r.length > 0;
  },
};

async function ensureDocument(p: ClaimedPost, token: string): Promise<string | null> {
  if (p.format !== "document") return null;
  let attachmentId = p.attachment_id;
  if (!attachmentId) {
    if (!p.slides?.length) throw new UserError("This carousel has no PDF and no slides to build one from. Add slides or upload a PDF, then press Retry.");
    const ws = await one<{ carousel_color: string | null }>("SELECT carousel_color FROM workspaces WHERE id = $1", [p.workspace_id]);
    const bytes = await buildCarouselPdf(p.slides, {
      name: publisherName(p.author_name), label: p.doc_title || p.topic, color: ws?.carousel_color,
    });
    const att = await one<{ id: string }>(
      `INSERT INTO attachments (workspace_id, filename, content_type, size_bytes, data) VALUES ($1,$2,'application/pdf',$3,$4) RETURNING id`,
      [p.workspace_id, `${(p.doc_title || p.topic).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`, bytes.length, Buffer.from(bytes)]);
    attachmentId = att!.id;
    await q("UPDATE posts SET attachment_id = $2 WHERE id = $1", [p.id, attachmentId]);
  }
  const file = await one<{ data: Buffer }>("SELECT data FROM attachments WHERE id = $1", [attachmentId]);
  return uploadDocument(token, p.author_urn, new Uint8Array(file!.data));
}

export function defaultDeps(): PublishDeps {
  return { store: pgPublishStore, accessTokenFor, prepareDocument: ensureDocument, createPost, flagReconnect };
}

export function defaultReshareDeps(): ReshareDeps {
  return { store: pgReshareStore, accessTokenFor, createPost, flagReconnect };
}
