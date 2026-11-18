import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../src/lib/accounts";
import { combineNotes, explain, jobStatus, postingStatus, type ErrorKind, type JobRun } from "../src/lib/explain";
import type { Post } from "../src/lib/posts";

const sam = { id: "founder", kind: "person", name: "Sam" } as Account;
const acme = { id: "page", kind: "organization", name: "Acme" } as Account;
const post = (o: Partial<Post>): Post => ({ status: "failed", attempts: 1, error: null, error_kind: null,
  reshare_status: "none", reshare_error: null, reshare_error_kind: null, ...o } as Post);
const failedPost = (kind: ErrorKind | null, error: string, o: Partial<Post> = {}) => explain("post", post({ error, error_kind: kind, ...o }), acme);
const failedReshare = (kind: ErrorKind | null, error: string) =>
  explain("reshare", post({ status: "posted", reshare_status: "failed", reshare_error: error, reshare_error_kind: kind }), sam);

test("nothing to explain without an error", () => {
  assert.equal(explain("post", post({}), acme), null);
  assert.equal(explain("reshare", post({ status: "posted" }), sam), null);
});

test("each kind reads as a plain sentence, and never includes the technical message", () => {
  const raw = 'LinkedIn POST /rest/posts failed (401): {"message":"The token used in the request has expired"}';
  assert.equal(failedReshare("reconnect", raw), "LinkedIn rejected Sam's connection. Reconnect it, then retry.");
  assert.equal(failedPost("maybe_live", "fetch failed (other side closed)"),
    "This post may already be on LinkedIn, but the app couldn't confirm it. Check the page: if it's there, use Mark posted; if not, press Retry.");
  assert.equal(failedReshare("maybe_live", "x"),
    "This reshare may already be on LinkedIn, but the app couldn't confirm it. Check Sam's profile: if it's there, use Mark shared; if not, press Retry.");
  assert.equal(failedPost("forbidden", "x"), "LinkedIn refused: Acme doesn't have permission to post there.");
  assert.equal(failedReshare("forbidden", "x"), "LinkedIn refused: Sam doesn't have permission to reshare this.");
  assert.equal(failedPost("rejected", "x"), "LinkedIn rejected the post. Check its text and any attachment, then press Retry.");
  assert.equal(failedReshare("rejected", "x"), "LinkedIn rejected the reshare. Press Retry to try again, or reshare it by hand.");
  assert.equal(failedPost("unavailable", "x"), "LinkedIn was unavailable. Press Retry to try again.");
  assert.equal(failedReshare("unreachable", "x"), "The app couldn't reach LinkedIn. Press Retry to try again.");
  assert.equal(failedPost("other", "TypeError: Cannot read properties of undefined (reading 'urn')"),
    "Something went wrong before this post was sent. Press Retry to try again.");

  const kinds: ErrorKind[] = ["maybe_live", "interrupted", "reconnect", "forbidden", "rejected", "unavailable", "unreachable", "other"];
  for (const k of kinds) {
    for (const text of [failedPost(k, raw), failedReshare(k, raw), failedPost(k, raw, { status: "planned" })]) {
      assert.doesNotMatch(text!, /POST|\/rest|401|token|\{|fetch failed/, `${k}: ${text}`);
    }
  }
});

test("messages written for people are shown as they are", () => {
  const readable = "This carousel has no PDF and no slides to build one from. Add slides or upload a PDF, then press Retry.";
  assert.equal(failedPost("plain", readable), readable);
});

test("a post that will retry on its own says so", () => {
  assert.equal(failedPost("unavailable", "x", { status: "planned" }), "LinkedIn was unavailable. It will retry automatically.");
  assert.equal(failedPost("unreachable", "x", { status: "planned" }), "The app couldn't reach LinkedIn. It will retry automatically.");
  assert.equal(failedPost("other", "x", { status: "planned" }), "Something went wrong before this post was sent. It will retry automatically.");
  assert.equal(failedPost("interrupted", "x", { status: "planned" }),
    "The last attempt was interrupted before anything was sent. It will retry automatically.");
  assert.equal(failedPost("interrupted", "x", { attempts: 3 }),
    "Publishing was interrupted 3 times before anything was sent. Press Retry to try again.");
});

test("errors recorded before kinds existed get a plain sentence, not the old technical message", () => {
  const old = "LinkedIn POST /rest/posts failed (500): x";
  assert.equal(failedPost(null, old),
    "This post didn't go out as planned. Check the page: if it's there, use Mark posted; if not, press Retry.");
  assert.equal(failedPost(null, old, { status: "planned" }), "The last attempt didn't work. It will retry automatically.");
  assert.equal(failedReshare(null, old),
    "This reshare didn't go out as planned. Check Sam's profile: if it's there, use Mark shared; if not, press Retry.");
});

test("works when the account was removed", () => {
  const e = explain("reshare", post({ status: "posted", reshare_status: "failed", reshare_error: "x", reshare_error_kind: "reconnect" }), null);
  assert.equal(e, "LinkedIn rejected the account's connection. Reconnect it, then retry.");
});

test("jobStatus describes the last run without any technical detail", () => {
  const now = Date.parse("2026-03-02T12:00:00Z");
  const run = (o: Partial<JobRun>): JobRun => ({ job: "publish", started_at: "2026-03-02T11:50:00Z", finished_at: "2026-03-02T11:50:05Z",
    ok: true, note: "Posted 1 post.", ...o });
  assert.deepEqual(jobStatus(undefined, now), { text: "Hasn't run yet.", bad: false });
  assert.deepEqual(jobStatus(run({}), now), { text: "Posted 1 post.", bad: false });
  assert.deepEqual(jobStatus(run({ ok: false, note: "Didn't finish. It'll try again automatically." }), now),
    { text: "Didn't finish. It'll try again automatically.", bad: true });
  assert.deepEqual(jobStatus(run({ ok: null, finished_at: null }), now), { text: "Running now…", bad: false });
  assert.deepEqual(jobStatus(run({ ok: null, finished_at: null, started_at: "2026-03-02T11:00:00Z" }), now),
    { text: "Last time it didn't finish. It'll try again automatically.", bad: true });
  assert.deepEqual(jobStatus(run({ note: null }), now), { text: "Finished.", bad: false }, "runs from before notes existed");
});

test("Settings shows automatic posting as one line: the last check, and anything worth knowing", () => {
  const now = Date.parse("2026-03-02T12:00:00Z");
  const run = (job: string, o: Partial<JobRun> = {}): JobRun => ({ job, started_at: "2026-03-02T11:50:00Z",
    finished_at: "2026-03-02T11:50:05Z", ok: true, note: job === "publish" ? "Nothing was due." : "Nothing to reshare.", ...o });
  assert.deepEqual(postingStatus([], now), { text: "Hasn't checked yet.", bad: false, at: null });
  assert.deepEqual(postingStatus([run("publish"), run("reshare")], now), { text: "Nothing was due.", bad: false, at: "2026-03-02T11:50:00Z" });
  assert.equal(postingStatus([run("publish", { note: "Posted 1 post." }), run("reshare")], now).text, "Posted 1 post.");
  assert.equal(postingStatus([run("publish", { note: "Posted 1 post." }), run("reshare", { note: "Reshared 1 post." })], now).text,
    "Posted 1 post. Reshared 1 post.");
  assert.deepEqual(postingStatus([run("publish"), run("reshare", { ok: false, note: "Didn't finish. It'll try again automatically." })], now),
    { text: "Didn't finish. It'll try again automatically.", bad: true, at: "2026-03-02T11:50:00Z" });
  assert.equal(postingStatus([run("comments", { note: "No new comments." })], now).text, "Hasn't checked yet.", "other jobs aren't shown");
  assert.equal(combineNotes(["Nothing was due.", "Nothing to reshare."]), "Nothing was due.");
  assert.equal(combineNotes(["2 need your attention in To do.", "2 need your attention in To do."]), "4 need your attention in To do.");
  assert.equal(combineNotes(["Posted 1 post. 1 needs your attention in To do.", "Reshared 1 post. 1 needs your attention in To do."]),
    "Posted 1 post. Reshared 1 post. 2 need your attention in To do.");
  assert.equal(combineNotes(["Posted 1 post. 1 will retry automatically.", "Nothing to reshare."]), "Posted 1 post. 1 will retry automatically.");
});
