// Publishing and recovery of posts stuck in 'publishing'. Runs without Postgres or network: the store is an
// in-memory stand-in for pgPublishStore, LinkedIn is faked, and a "crash" is a call that never returns.
import { deferred, fetchFailed, flush, never, timedOut } from "./offline";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ErrorKind } from "../src/lib/explain";
import { NotConnectedError } from "../src/lib/accounts";
import { UserError } from "../src/lib/errors";
import { LinkedInError, type PostInput } from "../src/lib/linkedin";
import {
  MAX_ATTEMPTS, STALE_AFTER_MS, STOPPED_BEFORE_SENDING, STOPPED_UNTRACKED, STOPPED_WHILE_SENDING,
  errorKind, publishDue, recoveryFor, type ClaimedPost, type PublishDeps, type PublishStore, type StaleClaim,
} from "../src/lib/publish";

const MIN = 60_000;

type Row = {
  id: string; topic: string; body: string; status: string; attempts: number; scheduled_for: number; api: boolean;
  publish_claim: string | null; publish_claimed_at: number | null; publish_sent_at: number | null; updated_at: number;
  error: string | null; error_kind: ErrorKind | null; linkedin_urn: string | null; url: string | null;
};

/** Mirrors the SQL in pgPublishStore, with a clock the test controls. */
class MemoryStore implements PublishStore {
  now = Date.parse("2026-03-02T14:00:00Z");
  rows = new Map<string, Row>();
  private claims = 0;
  /** Make the next markPosted calls throw, like a database blip right after LinkedIn accepted the post. */
  failMarkPosted = 0;

  add(p: Partial<Row> & { id: string }): Row {
    const row: Row = {
      topic: p.id, body: `Body of ${p.id}`, status: "planned", attempts: 0, scheduled_for: this.now - MIN, api: true,
      publish_claim: null, publish_claimed_at: null, publish_sent_at: null, updated_at: this.now,
      error: null, error_kind: null, linkedin_urn: null, url: null, ...p,
    };
    this.rows.set(row.id, row);
    return row;
  }
  get(id: string): Row { return this.rows.get(id)!; }
  advance(ms: number) { this.now += ms; }

  async findStale(olderThanMs: number): Promise<StaleClaim[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "publishing" && (r.publish_claimed_at ?? r.updated_at) < this.now - olderThanMs)
      .map((r) => ({ id: r.id, topic: r.topic, attempts: r.attempts, claim: r.publish_claim,
        sent_at: r.publish_sent_at === null ? null : new Date(r.publish_sent_at) }));
  }

  async claimDue(limit: number): Promise<ClaimedPost[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.status === "planned" && r.scheduled_for <= this.now && r.api)
      .sort((a, b) => a.scheduled_for - b.scheduled_for).slice(0, limit);
    return due.map((r) => {
      Object.assign(r, { status: "publishing", attempts: r.attempts + 1, publish_claim: `claim-${++this.claims}`,
        publish_claimed_at: this.now, publish_sent_at: null, updated_at: this.now });
      return { id: r.id, topic: r.topic, body: r.body, attempts: r.attempts, account_id: "acct", format: "text",
        doc_title: null, author_urn: "urn:li:organization:1", publish_claim: r.publish_claim } as unknown as ClaimedPost;
    });
  }

  async markSending(id: string, claim: string): Promise<boolean> {
    const r = this.get(id);
    if (r.status !== "publishing" || r.publish_claim !== claim) return false;
    r.publish_sent_at = this.now;
    return true;
  }

  async markPosted(id: string, urn: string, url: string): Promise<void> {
    if (this.failMarkPosted > 0) { this.failMarkPosted--; throw new Error("connection terminated unexpectedly"); }
    Object.assign(this.get(id), { status: "posted", linkedin_urn: urn, url, error: null, error_kind: null, updated_at: this.now,
      publish_claim: null, publish_claimed_at: null, publish_sent_at: null });
  }

  async release(id: string, claim: string | null, status: "planned" | "failed", error: string, kind: ErrorKind): Promise<boolean> {
    const r = this.get(id);
    if (r.status !== "publishing" || r.publish_claim !== claim) return false;
    Object.assign(r, { status, error, error_kind: kind, updated_at: this.now, publish_claim: null, publish_claimed_at: null, publish_sent_at: null });
    return true;
  }
}

/**
 * Fake LinkedIn plus hooks for the steps around it. `sent` is everything LinkedIn received, which is what
 * matters for double posting. Steps default to succeeding; a test swaps one out to crash, hang or fail.
 */
class World {
  store = new MemoryStore();
  sent: PostInput[] = [];
  /** Accounts flagged as needing a reconnect. */
  flagged: string[] = [];
  beforeSend: () => Promise<void> = async () => {};
  /** Runs after LinkedIn received the request; returns the URN LinkedIn answers with. */
  afterSend: (n: number) => Promise<string> = async (n) => `urn:li:share:${n}`;

  deps(): PublishDeps {
    return {
      store: this.store,
      accessTokenFor: async () => "token",
      prepareDocument: async () => { await this.beforeSend(); return null; },
      createPost: async (_token, input) => { this.sent.push(input); return this.afterSend(this.sent.length); },
      flagReconnect: async (id) => { this.flagged.push(id); },
    };
  }
  /** A publish run that completes. */
  /** A run that completes; returns its technical log (see note() for the dashboard's sentence). */
  async run() { return (await publishDue(this.deps())).log; }
  async note() { return (await publishDue(this.deps())).note; }
  /** A publish run whose process dies at whatever step never returns. The returned promise never settles. */
  crash() { void publishDue(this.deps()); return flush(); }
  sentCount(id: string) { return this.sent.filter((s) => s.text === `Body of ${id}`).length; }
}

let w: World;
beforeEach(() => { w = new World(); });

test("publishes a due post and records the LinkedIn link", async () => {
  w.store.add({ id: "a" });
  w.store.add({ id: "later", scheduled_for: w.store.now + 60 * MIN });
  assert.equal(await w.run(), "posted a");
  const a = w.store.get("a");
  assert.equal(a.status, "posted");
  assert.equal(a.linkedin_urn, "urn:li:share:1");
  assert.equal(a.url, "https://www.linkedin.com/feed/update/urn:li:share:1/");
  assert.equal(a.publish_claim, null);
  assert.equal(w.store.get("later").status, "planned");
});

test("LinkedIn errors still retry or fail as before, and clear the claim", async () => {
  w.store.add({ id: "flaky" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (503)", 503, "busy"); };
  assert.match(await w.run(), /^will retry flaky/);
  assert.equal(w.store.get("flaky").status, "planned");
  assert.equal(w.store.get("flaky").publish_sent_at, null);

  w.store.rows.delete("flaky");
  w.store.add({ id: "bad" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (422)", 422, "nope"); };
  assert.match(await w.run(), /^failed bad/);
  assert.equal(w.store.get("bad").status, "failed");
});

test("a rejected token (401) flags the account for reconnecting; other failures don't", async () => {
  w.store.add({ id: "a" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn POST /rest/posts failed (401)", 401, "expired"); };
  assert.match(await w.run(), /^failed a/);
  assert.deepEqual(w.flagged, ["acct"]);

  for (const [id, err] of [["b", new LinkedInError("LinkedIn POST /rest/posts failed (403)", 403, "no")],
                           ["c", new LinkedInError("LinkedIn POST /rest/posts failed (503)", 503, "busy")]] as const) {
    w.store.add({ id });
    w.afterSend = async () => { throw err; };
    await w.run();
  }
  assert.deepEqual(w.flagged, ["acct"], "only the 401");
});

test("LinkedIn accepting a post without returning its id is flagged, not retried", async () => {
  w.store.add({ id: "a" });
  w.afterSend = async () => { throw new LinkedInError("LinkedIn created the post but returned no id", 201, ""); };
  assert.equal(await w.run(), "failed, may be live on LinkedIn: a: LinkedIn created the post but returned no id");
  const a = w.store.get("a");
  assert.equal(a.status, "failed");
  assert.deepEqual([a.error_kind, a.error], ["maybe_live", "LinkedIn created the post but returned no id"]);
  assert.equal(a.publish_claim, null);

  w.afterSend = async (n) => `urn:li:share:${n}`;
  w.store.advance(60 * MIN);
  assert.equal(await w.run(), "nothing due");
  assert.equal(w.sentCount("a"), 1, "not posted twice");
});

test("a connection lost after the request went out is flagged, not retried", async () => {
  const cases: [string, Error][] = [
    ["closed", fetchFailed("UND_ERR_SOCKET", "other side closed")],
    ["reset", fetchFailed("ECONNRESET", "read ECONNRESET")],
    ["timeout", timedOut()],
  ];
  for (const [id, err] of cases) {
    w.store.add({ id });
    w.afterSend = async () => { throw err; };
    assert.match(await w.run(), new RegExp(`^failed, may be live on LinkedIn: ${id}: `));
    assert.equal(w.store.get(id).status, "failed", id);
    assert.equal(w.sentCount(id), 1, id);
  }
  assert.deepEqual([w.store.get("closed").error_kind, w.store.get("closed").error], ["maybe_live", "fetch failed (other side closed)"]);
  w.afterSend = async (n) => `urn:li:share:${n}`;
  w.store.advance(60 * MIN);
  assert.equal(await w.run(), "nothing due");
});

test("a connection that never opened is still retried automatically", async () => {
  w.store.add({ id: "a" });
  w.afterSend = async () => { throw fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.linkedin.com"); };
  assert.equal(await w.run(), "will retry a: fetch failed (getaddrinfo ENOTFOUND api.linkedin.com)");
  assert.equal(w.store.get("a").status, "planned");

  w.afterSend = async () => { throw fetchFailed("ECONNREFUSED"); };
  assert.match(await w.run(), /^will retry a/);
  w.afterSend = async () => { throw fetchFailed("UND_ERR_CONNECT_TIMEOUT"); };
  assert.match(await w.run(), /^failed a/, "gives up after MAX_ATTEMPTS, as before");
  assert.deepEqual([w.store.get("a").error_kind, w.store.get("a").error], ["unreachable", "fetch failed (UND_ERR_CONNECT_TIMEOUT (test))"]);
});

test("network errors before the create request (token refresh, document upload) are still retried", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = async () => { throw fetchFailed("UND_ERR_SOCKET", "other side closed"); };
  assert.equal(await w.run(), "will retry a: fetch failed (other side closed)");
  assert.equal(w.store.get("a").status, "planned");
  assert.equal(w.sent.length, 0);
});

test("a run that died before sending is retried automatically once the claim goes stale", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;                       // e.g. killed while building the carousel PDF
  await w.crash();
  assert.equal(w.store.get("a").status, "publishing");

  w.beforeSend = async () => {};
  w.store.advance(STALE_AFTER_MS - MIN);
  assert.equal(await w.run(), "nothing due", "a fresh claim is left alone; its worker may still be running");
  assert.equal(w.store.get("a").status, "publishing");

  w.store.advance(2 * MIN);
  assert.equal(await w.run(), "recovered stuck post a: will retry\nposted a");
  assert.equal(w.store.get("a").status, "posted");
  assert.equal(w.store.get("a").attempts, 2);
  assert.equal(w.sentCount("a"), 1);
});

test("a run that died after sending is flagged for a person, never re-sent", async () => {
  w.store.add({ id: "a" });
  w.afterSend = never;                        // LinkedIn got the request; the process died before the answer
  await w.crash();
  assert.equal(w.sentCount("a"), 1);

  w.afterSend = async (n) => `urn:li:share:${n}`;
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.run(), "recovered stuck post a: failed, may be live on LinkedIn");
  const a = w.store.get("a");
  assert.equal(a.status, "failed");
  assert.deepEqual([a.error_kind, a.error], ["maybe_live", STOPPED_WHILE_SENDING]);
  assert.equal(a.publish_claim, null);

  w.store.advance(60 * MIN);
  assert.equal(await w.run(), "nothing due");
  assert.equal(w.sentCount("a"), 1, "not posted twice");
});

test("a post whose runs keep dying before sending gives up after MAX_ATTEMPTS", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await w.crash();                          // recovers the previous stuck claim, then claims again and dies
    assert.equal(w.store.get("a").status, "publishing");
    assert.equal(w.store.get("a").attempts, i);
    w.store.advance(STALE_AFTER_MS + MIN);
  }
  w.beforeSend = async () => {};              // would succeed now, but the post has used up its attempts
  assert.equal(await w.run(), `recovered stuck post a: failed after ${MAX_ATTEMPTS} attempts`);
  assert.equal(w.store.get("a").status, "failed");
  assert.deepEqual([w.store.get("a").error_kind, w.store.get("a").error], ["interrupted", STOPPED_BEFORE_SENDING]);
  assert.equal(w.sent.length, 0);
});

test("posts stuck before this fix (no claim recorded) are recovered as 'check LinkedIn'", async () => {
  w.store.add({ id: "old", status: "publishing", attempts: 1, updated_at: w.store.now - 3 * 24 * 60 * MIN });
  w.store.add({ id: "recent", status: "publishing", attempts: 1, updated_at: w.store.now - MIN });
  assert.equal(await w.run(), "recovered stuck post old: failed, may be live on LinkedIn");
  assert.equal(w.store.get("old").status, "failed");
  assert.deepEqual([w.store.get("old").error_kind, w.store.get("old").error], ["maybe_live", STOPPED_UNTRACKED]);
  assert.equal(w.store.get("recent").status, "publishing", "may still be in flight on the old code");
});

test("one stuck post doesn't hold up the others in its batch", async () => {
  w.store.add({ id: "a", scheduled_for: w.store.now - 3 * MIN });
  w.store.add({ id: "b", scheduled_for: w.store.now - 2 * MIN });
  w.store.add({ id: "c", scheduled_for: w.store.now - 1 * MIN });
  w.afterSend = never;                        // dies while sending a; b and c were claimed but never started
  await w.crash();
  assert.deepEqual(["a", "b", "c"].map((id) => w.store.get(id).status), ["publishing", "publishing", "publishing"]);

  w.afterSend = async (n) => `urn:li:share:${n}`;
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.deepEqual(["a", "b", "c"].map((id) => w.store.get(id).status), ["failed", "posted", "posted"]);
  assert.deepEqual(["a", "b", "c"].map((id) => w.sentCount(id)), [1, 1, 1]);
});

test("a slow worker whose claim was recovered can't send the post again", async () => {
  w.store.add({ id: "a" });
  const slow = deferred<void>();
  w.beforeSend = () => slow.promise;
  const zombie = publishDue(w.deps()).then((r) => r.log);
  await flush();

  w.beforeSend = async () => {};
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.run(), "recovered stuck post a: will retry\nposted a");

  slow.resolve();                             // the original worker wakes up
  assert.equal(await zombie, "skipped a: taken over by another run");
  assert.equal(w.sentCount("a"), 1);
  assert.equal(w.store.get("a").status, "posted");
});

test("a late answer from a recovered worker: success is recorded, failure doesn't overwrite", async () => {
  w.store.add({ id: "ok" });
  const answer = deferred<string>();
  w.afterSend = () => answer.promise;
  const zombie = publishDue(w.deps()).then((r) => r.log);
  await flush();
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.equal(w.store.get("ok").status, "failed");
  answer.resolve("urn:li:share:77");
  assert.equal(await zombie, "posted ok");
  assert.equal(w.store.get("ok").status, "posted");
  assert.equal(w.store.get("ok").linkedin_urn, "urn:li:share:77");

  w.store.add({ id: "err" });
  const answer2 = deferred<string>();
  w.afterSend = () => answer2.promise;
  const zombie2 = publishDue(w.deps()).then((r) => r.log);
  await flush();
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  answer2.reject(new LinkedInError("LinkedIn POST /rest/posts failed (504)", 504, "timeout"));
  assert.match(await zombie2, /^gave up \(taken over\) err/);
  assert.equal(w.store.get("err").status, "failed", "not put back to 'planned', which could post it twice");
  assert.deepEqual([w.store.get("err").error_kind, w.store.get("err").error], ["maybe_live", STOPPED_WHILE_SENDING]);
});

test("if saving a successful post fails, it is flagged later instead of re-posted", async () => {
  w.store.add({ id: "a" });
  w.store.failMarkPosted = 1;
  assert.match(await w.run(), /^posted a \(https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:1\/\) but couldn't save it/);
  assert.equal(w.store.get("a").status, "publishing");
  w.store.advance(STALE_AFTER_MS + MIN);
  await w.run();
  assert.equal(w.store.get("a").status, "failed");
  assert.deepEqual([w.store.get("a").error_kind, w.store.get("a").error], ["maybe_live", STOPPED_WHILE_SENDING]);
  assert.equal(w.sentCount("a"), 1);
});

test("each run also says what happened in plain words, for the dashboard", async () => {
  assert.equal(await w.note(), "Nothing was due.");

  w.store.add({ id: "a" });
  w.store.add({ id: "b" });
  assert.equal(await w.note(), "Posted 2 posts.");

  w.store.add({ id: "ok", scheduled_for: w.store.now - 3 * MIN });
  w.store.add({ id: "busy", scheduled_for: w.store.now - 2 * MIN });
  w.store.add({ id: "refused", scheduled_for: w.store.now - 1 * MIN });
  w.afterSend = async (n) => {
    if (w.sent[n - 1].text === "Body of busy") throw new LinkedInError("LinkedIn POST /rest/posts failed (503)", 503, "");
    if (w.sent[n - 1].text === "Body of refused") throw new LinkedInError("LinkedIn POST /rest/posts failed (422)", 422, "");
    return `urn:li:share:${n}`;
  };
  const note = await w.note();
  assert.equal(note, "Posted 1 post. 1 will retry automatically. 1 needs your attention in To do.");
  assert.doesNotMatch(note, /LinkedIn POST|503|422|fetch/, "no technical detail");
});

test("a stuck post that recovery puts back and this run then posts reads as simply posted", async () => {
  w.store.add({ id: "a" });
  w.beforeSend = never;
  await w.crash();
  w.beforeSend = async () => {};
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.note(), "Posted 1 post.");

  w.store.add({ id: "b" });
  w.afterSend = never;
  await w.crash();
  w.store.advance(STALE_AFTER_MS + MIN);
  assert.equal(await w.note(), "1 needs your attention in To do.");
});

test("errorKind sorts failures into what the dashboard can explain", () => {
  const li = (status: number) => new LinkedInError(`LinkedIn POST /rest/posts failed (${status})`, status, "");
  const cases: [unknown, boolean, string][] = [
    [li(201), true, "maybe_live"],                      // created without an id
    [fetchFailed("UND_ERR_SOCKET"), true, "maybe_live"], // connection lost after sending
    [fetchFailed("UND_ERR_SOCKET"), false, "unreachable"], // same error before the create request: nothing to check
    [fetchFailed("ENOTFOUND"), true, "unreachable"],
    [timedOut(), false, "unreachable"],
    [li(401), true, "reconnect"],
    [new NotConnectedError("The LinkedIn connection expired. Reconnect it in Settings."), false, "reconnect"],
    [li(403), true, "forbidden"],
    [li(400), true, "rejected"],
    [li(422), true, "rejected"],
    [li(429), true, "unavailable"],
    [li(503), true, "unavailable"],
    [li(504), true, "maybe_live"],   // a gateway gave up after the request went out: it may exist
    [li(504), false, "unavailable"], // before the create request (e.g. document upload): nothing to check
    [new UserError("This carousel has no PDF and no slides to build one from."), false, "plain"],
    [new TypeError("Cannot read properties of undefined (reading 'urn')"), false, "other"],
  ];
  for (const [e, sending, kind] of cases) assert.equal(errorKind(e, sending), kind, `${(e as Error).message} sending=${sending}`);
});

test("a disconnected or expired account fails right away (no pointless retries) and asks for a reconnect", async () => {
  w.store.add({ id: "a" });
  const deps = w.deps();
  deps.accessTokenFor = async () => { throw new NotConnectedError("The LinkedIn connection expired. Reconnect it in Settings."); };
  assert.match((await publishDue(deps)).log, /^failed a/);
  assert.deepEqual([w.store.get("a").status, w.store.get("a").error_kind, w.store.get("a").attempts], ["failed", "reconnect", 1]);
  assert.deepEqual(w.flagged, ["acct"]);
});

test("recoveryFor only retries when nothing can have reached LinkedIn", () => {
  const p = (o: Partial<StaleClaim>): StaleClaim => ({ id: "x", topic: "x", attempts: 1, claim: "c", sent_at: null, ...o });
  assert.deepEqual(recoveryFor(p({})), { status: "planned", error: STOPPED_BEFORE_SENDING, kind: "interrupted" });
  assert.deepEqual(recoveryFor(p({ attempts: MAX_ATTEMPTS })), { status: "failed", error: STOPPED_BEFORE_SENDING, kind: "interrupted" });
  assert.deepEqual(recoveryFor(p({ sent_at: new Date() })), { status: "failed", error: STOPPED_WHILE_SENDING, kind: "maybe_live" });
  assert.deepEqual(recoveryFor(p({ sent_at: "2026-03-02 14:00:00+00" })), { status: "failed", error: STOPPED_WHILE_SENDING, kind: "maybe_live" });
  assert.deepEqual(recoveryFor(p({ claim: null })), { status: "failed", error: STOPPED_UNTRACKED, kind: "maybe_live" });
});
