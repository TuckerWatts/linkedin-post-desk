// Resharing and recovery of reshares stuck in 'resharing'. Runs without Postgres or network: the store is an
// in-memory stand-in for pgReshareStore, LinkedIn is faked, and a "crash" is a call that never returns.
import { deferred, fetchFailed, flush, never } from "./offline";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ErrorKind } from "../src/lib/explain";
import { LinkedInError, type PostInput } from "../src/lib/linkedin";
import {
  MAX_ATTEMPTS, STALE_AFTER_MS, STOPPED_BEFORE_SENDING, STOPPED_UNTRACKED, STOPPED_WHILE_SENDING,
  reshareDue, reshareRecoveryFor, type ClaimedReshare, type ReshareDeps, type ReshareStore, type StaleClaim,
} from "../src/lib/publish";

const MIN = 60_000;

type Row = {
  id: string; topic: string; share_note: string; linkedin_urn: string | null; api: boolean;
  reshare_status: string; reshare_at: number; reshare_attempts: number; reshare_urn: string | null; reshare_error: string | null;
  reshare_error_kind: ErrorKind | null;
  reshare_claim: string | null; reshare_claimed_at: number | null; reshare_sent_at: number | null; updated_at: number;
};

/** Mirrors the SQL in pgReshareStore, with a clock the test controls. */
class MemoryReshareStore implements ReshareStore {
  now = Date.parse("2026-03-02T14:00:00Z");
  rows = new Map<string, Row>();
  private claims = 0;
  /** Make the next markDone calls throw, like a database blip right after LinkedIn accepted the reshare. */
  failMarkDone = 0;

  add(p: Partial<Row> & { id: string }): Row {
    const row: Row = {
      topic: p.id, share_note: `Note on ${p.id}`, linkedin_urn: `urn:li:share:parent-${p.id}`, api: true,
      reshare_status: "pending", reshare_at: this.now - MIN, reshare_attempts: 0, reshare_urn: null, reshare_error: null, reshare_error_kind: null,
      reshare_claim: null, reshare_claimed_at: null, reshare_sent_at: null, updated_at: this.now, ...p,
    };
    this.rows.set(row.id, row);
    return row;
  }
  get(id: string): Row { return this.rows.get(id)!; }
  advance(ms: number) { this.now += ms; }

  async findStale(olderThanMs: number): Promise<StaleClaim[]> {
    return [...this.rows.values()]
      .filter((r) => r.reshare_status === "resharing" && (r.reshare_claimed_at ?? r.updated_at) < this.now - olderThanMs)
      .map((r) => ({ id: r.id, topic: r.topic, attempts: r.reshare_attempts, claim: r.reshare_claim,
        sent_at: r.reshare_sent_at === null ? null : new Date(r.reshare_sent_at) }));
  }

  async claimDue(limit: number): Promise<ClaimedReshare[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.reshare_status === "pending" && r.reshare_at <= this.now && r.linkedin_urn && r.api)
      .sort((a, b) => a.reshare_at - b.reshare_at).slice(0, limit);
    return due.map((r) => {
      Object.assign(r, { reshare_status: "resharing", reshare_attempts: r.reshare_attempts + 1,
        reshare_claim: `claim-${++this.claims}`, reshare_claimed_at: this.now, reshare_sent_at: null, updated_at: this.now });
      return { id: r.id, topic: r.topic, share_note: r.share_note, linkedin_urn: r.linkedin_urn, reshare_account_id: "person",
        person_urn: "urn:li:person:1", reshare_claim: r.reshare_claim } as unknown as ClaimedReshare;
    });
  }

  async markSending(id: string, claim: string): Promise<boolean> {
    const r = this.get(id);
    if (r.reshare_status !== "resharing" || r.reshare_claim !== claim) return false;
    r.reshare_sent_at = this.now;
    return true;
  }

  async markDone(id: string, urn: string): Promise<void> {
    if (this.failMarkDone > 0) { this.failMarkDone--; throw new Error("connection terminated unexpectedly"); }
    Object.assign(this.get(id), { reshare_status: "done", reshare_urn: urn, reshare_error: null, reshare_error_kind: null, updated_at: this.now,
      reshare_claim: null, reshare_claimed_at: null, reshare_sent_at: null });
  }

  async release(id: string, claim: string | null, status: "pending" | "failed", error: string, kind: ErrorKind): Promise<boolean> {
    const r = this.get(id);
    if (r.reshare_status !== "resharing" || r.reshare_claim !== claim) return false;
    Object.assign(r, { reshare_status: status, reshare_error: error, reshare_error_kind: kind, updated_at: this.now,
      reshare_claim: null, reshare_claimed_at: null, reshare_sent_at: null });
    return true;
  }
}

/** Fake LinkedIn. `sent` is every reshare LinkedIn received, which is what matters for double posting. */
class World {
  store = new MemoryReshareStore();
  sent: PostInput[] = [];
  /** Accounts flagged as needing a reconnect. */
  flagged: string[] = [];
  /** Runs before the request is sent (token lookup and refresh). */
  beforeSend: () => Promise<string> = async () => "token";
  /** Runs after LinkedIn received the request; returns the URN LinkedIn answers with. */
  afterSend: (n: number) => Promise<string> = async (n) => `urn:li:share:reshare-${n}`;

  deps(): ReshareDeps {
    return {
      store: this.store,
      accessTokenFor: () => this.beforeSend(),
      createPost: async (_token, input) => { this.sent.push(input); return this.afterSend(this.sent.length); },
      flagReconnect: async (id) => { this.flagged.push(id); },
    };
  }
  /** A run that completes; returns its technical log (see note() for the dashboard's sentence). */
  async run() { return (await reshareDue(this.deps())).log; }
  async note() { return (await reshareDue(this.deps())).note; }
  /** A run whose process dies at whatever step never returns. */
  crash() { void reshareDue(this.deps()); return flush(); }
  sentCount(id: string) { return this.sent.filter((s) => s.reshareOf === `urn:li:share:parent-${id}`).length; }
}

let w: World;
beforeEach(() => { w = new World(); });
/** [kind, technical detail] of a reshare's recorded problem. */
const problem = (id: string) => [w.store.get(id).reshare_error_kind, w.store.get(id).reshare_error];

test("reshares a due post from the person's account", async () => {
  w.store.add({ id: "a" });
  w.store.add({ id: "later", reshare_at: w.store.now + 60 * MIN });
  assert.equal(await w.run(), "reshared a");
  const a = w.store.get("a");
  assert.equal(a.reshare_status, "done");
  assert.equal(a.reshare_urn, "urn:li:share:reshare-1");
  assert.equal(a.reshare_claim, null);
  assert.deepEqual(w.sent[0], { author: "urn:li:person:1", text: "Note on a", reshareOf: "urn:li:share:parent-a" });
  assert.equal(w.store.get("later").reshare_status, "pending");
});

test("a reshare LinkedIn rejects still fails right away, as before", async () => {
  w.store.add({ id: "a" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (503)", 503, "busy"); };
  assert.match(await w.run(), /^reshare failed a: LinkedIn POST/);
  assert.equal(w.store.get("a").reshare_status, "failed");
  assert.equal(w.store.get("a").reshare_claim, null);
});

test("each run also says what happened in plain words", async () => {
  assert.equal(await w.note(), "Nothing to reshare.");
  w.store.add({ id: "a" });
  w.store.add({ id: "b" });
  w.afterSend = async (n) => {
    if (n === 2) throw new LinkedInError("LinkedIn POST /rest/posts failed (401)", 401, "expired");
    return `urn:li:share:reshare-${n}`;
  };
  assert.equal(await w.note(), "Reshared 1 post. 1 needs your attention in To do.");
});

test("a rejected token (401) flags the reshare account for reconnecting", async () => {
  w.store.add({ id: "a" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (401)", 401, "expired"); };
  assert.match(await w.run(), /^reshare failed a/);
  assert.deepEqual(w.flagged, ["person"]);
  w.store.add({ id: "b" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (422)", 422, "no"); };
  await w.run();
  assert.deepEqual(w.flagged, ["person"], "only the 401");
});

test("a reshare that may have gone through says so instead of inviting a Retry", async () => {
  w.store.add({ id: "lost" });
  w.afterSend = async () => { throw fetchFailed("UND_ERR_SOCKET", "other side closed"); };
  assert.match(await w.run(), /^reshare failed lost: fetch failed \(other side closed\)$/);
  assert.equal(w.store.get("lost").reshare_status, "failed");
  assert.deepEqual(problem("lost"), ["maybe_live", "fetch failed (other side closed)"]);

  w.store.add({ id: "noid" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn created the post but returned no id", 201, ""); };
  await w.run();
  assert.deepEqual(problem("noid"), ["maybe_live", "LinkedIn created the post but returned no id"]);

  w.store.add({ id: "dns" });
  w.afterSend = async () => { throw fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.linkedin.com"); };
  await w.run();
  assert.equal(w.store.get("dns").reshare_status, "failed");
  assert.deepEqual(problem("dns"), ["unreachable", "fetch failed (getaddrinfo ENOTFOUND api.linkedin.com)"], "never connected");
  assert.deepEqual(["lost", "noid", "dns"].map((id) => w.sentCount(id)), [1, 1, 1]);
});

test("a crash no longer shows as reshared: the reshare stays in flight until recovered", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;                       // e.g. killed while refreshing the token
  await w.crash();
  assert.equal(w.store.get("a").reshare_status, "resharing", "used to be 'done' here, with nothing on LinkedIn");
  assert.equal(w.store.get("a").reshare_urn, null);
});

test("a run that died before sending is retried once the claim goes stale", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;
  await w.crash();

  w.beforeSend = async () => "token";
  w.store.advance(STALE_AFTER_MS - MIN);
  assert.equal(await w.run(), "nothing to reshare", "a fresh claim is left alone; its worker may still be running");
  assert.equal(w.store.get("a").reshare_status, "resharing");

  w.store.advance(2 * MIN);
  assert.equal(await w.run(), "recovered stuck reshare a: will retry\nreshared a");
  assert.equal(w.store.get("a").reshare_status, "done");
  assert.equal(w.store.get("a").reshare_attempts, 2);
  assert.equal(w.sentCount("a"), 1);
});

test("a run that died after sending is flagged for a person, never re-sent", async () => {
  w.store.add({ id: "a" });
  w.afterSend = never;                        // LinkedIn got the request; the process died before the answer
  await w.crash();
  assert.equal(w.sentCount("a"), 1);

  w.afterSend = async (n) => `urn:li:share:reshare-${n}`;
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.run(), "recovered stuck reshare a: failed, may be live on LinkedIn");
  const a = w.store.get("a");
  assert.equal(a.reshare_status, "failed");
  assert.deepEqual(problem("a"), ["maybe_live", STOPPED_WHILE_SENDING]);
  assert.equal(a.reshare_claim, null);

  w.store.advance(60 * MIN);
  assert.equal(await w.run(), "nothing to reshare");
  assert.equal(w.sentCount("a"), 1, "not reshared twice");
});

test("a reshare whose runs keep dying before sending gives up after MAX_ATTEMPTS", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await w.crash();                          // recovers the previous stuck claim, then claims again and dies
    assert.equal(w.store.get("a").reshare_status, "resharing");
    assert.equal(w.store.get("a").reshare_attempts, i);
    w.store.advance(STALE_AFTER_MS + MIN);
  }
  w.beforeSend = async () => "token";         // would succeed now, but the reshare has used up its attempts
  assert.equal(await w.run(), `recovered stuck reshare a: failed after ${MAX_ATTEMPTS} attempts`);
  assert.equal(w.store.get("a").reshare_status, "failed");
  assert.deepEqual(problem("a"), ["interrupted", STOPPED_BEFORE_SENDING]);
  assert.equal(w.sent.length, 0);
});

test("one stuck reshare doesn't hold up the others in its batch", async () => {
  w.store.add({ id: "a", reshare_at: w.store.now - 3 * MIN });
  w.store.add({ id: "b", reshare_at: w.store.now - 2 * MIN });
  w.store.add({ id: "c", reshare_at: w.store.now - 1 * MIN });
  w.afterSend = never;                        // dies while sending a; b and c were claimed but never started
  await w.crash();
  assert.deepEqual(["a", "b", "c"].map((id) => w.store.get(id).reshare_status), ["resharing", "resharing", "resharing"]);

  w.afterSend = async (n) => `urn:li:share:reshare-${n}`;
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.deepEqual(["a", "b", "c"].map((id) => w.store.get(id).reshare_status), ["failed", "done", "done"]);
  assert.deepEqual(["a", "b", "c"].map((id) => w.sentCount(id)), [1, 1, 1]);
});

test("a slow worker whose claim was recovered can't reshare again", async () => {
  w.store.add({ id: "a" });
  const slow = deferred<string>();
  w.beforeSend = () => slow.promise;
  const zombie = reshareDue(w.deps()).then((r) => r.log);
  await flush();

  w.beforeSend = async () => "token";
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.run(), "recovered stuck reshare a: will retry\nreshared a");

  slow.resolve("token");                      // the original worker wakes up
  assert.equal(await zombie, "skipped reshare a: taken over by another run");
  assert.equal(w.sentCount("a"), 1);
  assert.equal(w.store.get("a").reshare_status, "done");
});

test("a late answer from a recovered worker: success is recorded, failure doesn't overwrite", async () => {
  w.store.add({ id: "ok" });
  const answer = deferred<string>();
  w.afterSend = () => answer.promise;
  const zombie = reshareDue(w.deps()).then((r) => r.log);
  await flush();
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.equal(w.store.get("ok").reshare_status, "failed");
  answer.resolve("urn:li:share:77");
  assert.equal(await zombie, "reshared ok");
  assert.equal(w.store.get("ok").reshare_status, "done");
  assert.equal(w.store.get("ok").reshare_urn, "urn:li:share:77");

  w.store.add({ id: "err" });
  const answer2 = deferred<string>();
  w.afterSend = () => answer2.promise;
  const zombie2 = reshareDue(w.deps()).then((r) => r.log);
  await flush();
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  answer2.reject(new LinkedInError("LinkedIn POST /rest/posts failed (504)", 504, "timeout"));
  assert.match(await zombie2, /^reshare gave up \(taken over\) err/);
  assert.equal(w.store.get("err").reshare_status, "failed");
  assert.deepEqual(problem("err"), ["maybe_live", STOPPED_WHILE_SENDING], "keeps the 'check LinkedIn' flag");
});

test("if saving a successful reshare fails, it is flagged later instead of reshared again", async () => {
  w.store.add({ id: "a" });
  w.store.failMarkDone = 1;
  assert.match(await w.run(), /^reshared a \(https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:reshare-1\/\) but couldn't save it/);
  assert.equal(w.store.get("a").reshare_status, "resharing");
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.equal(w.store.get("a").reshare_status, "failed");
  assert.deepEqual(problem("a"), ["maybe_live", STOPPED_WHILE_SENDING]);
  assert.equal(w.sentCount("a"), 1);
});

test("reshareRecoveryFor only retries when nothing can have reached LinkedIn", () => {
  const p = (o: Partial<StaleClaim>): StaleClaim => ({ id: "x", topic: "x", attempts: 1, claim: "c", sent_at: null, ...o });
  assert.deepEqual(reshareRecoveryFor(p({})), { status: "pending", error: STOPPED_BEFORE_SENDING, kind: "interrupted" });
  assert.deepEqual(reshareRecoveryFor(p({ attempts: MAX_ATTEMPTS })), { status: "failed", error: STOPPED_BEFORE_SENDING, kind: "interrupted" });
  assert.deepEqual(reshareRecoveryFor(p({ sent_at: new Date() })), { status: "failed", error: STOPPED_WHILE_SENDING, kind: "maybe_live" });
  assert.deepEqual(reshareRecoveryFor(p({ claim: null })), { status: "failed", error: STOPPED_UNTRACKED, kind: "maybe_live" });
});
