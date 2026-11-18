import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../src/lib/accounts";
import type { Post } from "../src/lib/posts";
import { needsReconnect, todos } from "../src/lib/todo";

const NOW = Date.parse("2026-03-02T12:00:00Z");
const account = (id: string, o: Partial<Account> = {}): Account => ({
  id, kind: "organization", name: id, urn: `urn:li:organization:${id}`, connected: true,
  token_expires_at: "2026-04-30T00:00:00Z", reconnect_needed_at: null, ...o,
} as Account);
const page = account("page", { name: "Acme" });
const founder = account("founder", { kind: "person", name: "Sam", urn: "urn:li:person:sam" });
const post = (id: string, o: Partial<Post>): Post => ({
  id, status: "posted", reshare_status: "none", account_id: "page", reshare_account_id: "founder",
  scheduled_for: null, reshare_at: null, posted_at: null, updated_at: "2026-03-02T12:00:00Z", ...o,
} as Post);

test("the to-do list has failed posts and failed reshares", () => {
  const list = todos([
    post("planned", { status: "planned" }),
    post("publishing", { status: "publishing" }),
    post("ok", { reshare_status: "done" }),
    post("resharing", { reshare_status: "resharing" }),
    post("reshare-failed", { reshare_status: "failed", reshare_at: "2026-03-01T17:00:00Z" }),
    post("post-failed", { status: "failed", scheduled_for: "2026-03-02T09:00:00Z" }),
    post("draft", { status: "draft" }),
    post("rejected", { status: "rejected" }),
  ], [page, founder], NOW);
  assert.deepEqual(list.map((t) => [t.kind, t.post.id, t.account?.name]), [
    ["reshare", "reshare-failed", "Sam"],
    ["post", "post-failed", "Acme"],
  ]);
});

test("items are ordered by the date they show (when they were due), not when they failed", () => {
  const list = todos([
    post("due-wed", { status: "failed", scheduled_for: "2026-03-04T14:00:00Z", updated_at: "2026-03-04T14:00:01Z" }),
    post("due-tue-reshare", { reshare_status: "failed", reshare_at: "2026-03-03T17:00:00Z", updated_at: "2026-03-05T10:00:00Z" }),
    post("due-mon", { status: "failed", scheduled_for: "2026-03-02T14:00:00Z", updated_at: "2026-03-06T10:00:00Z" }),
  ], [page, founder], NOW);
  assert.deepEqual(list.map((t) => [t.post.id, t.when]), [
    ["due-mon", "2026-03-02T14:00:00Z"],
    ["due-tue-reshare", "2026-03-03T17:00:00Z"],
    ["due-wed", "2026-03-04T14:00:00Z"],
  ]);
  const noDate = todos([post("x", { reshare_status: "failed", posted_at: "2026-03-01T08:00:00Z" })], [founder], NOW);
  assert.equal(noDate[0].when, "2026-03-01T08:00:00Z", "falls back to when the post went out");
});

test("needsReconnect: rejected, expired or disconnected tokens; never for post-by-hand accounts", () => {
  assert.equal(needsReconnect(page, NOW), false);
  assert.equal(needsReconnect(account("x", { reconnect_needed_at: "2026-03-01T00:00:00Z" }), NOW), true, "LinkedIn rejected it");
  assert.equal(needsReconnect(account("x", { token_expires_at: "2026-03-01T00:00:00Z" }), NOW), true, "expired");
  assert.equal(needsReconnect(account("x", { connected: false, token_expires_at: null }), NOW), true, "disconnected");
  assert.equal(needsReconnect(account("x", { urn: "manual:organization:acme", connected: false, token_expires_at: null }), NOW), false);
  assert.equal(needsReconnect(null, NOW), false);
});

test("items on an account that needs reconnecting say so", () => {
  const rejected = account("founder", { kind: "person", urn: "urn:li:person:sam", reconnect_needed_at: "2026-03-02T11:00:00Z" });
  const list = todos([
    post("reshare", { reshare_status: "failed", reshare_at: "2026-03-02T10:00:00Z" }),
    post("post", { status: "failed", scheduled_for: "2026-03-02T11:00:00Z" }),
  ], [page, rejected], NOW);
  assert.deepEqual(list.map((t) => [t.post.id, t.reconnect]), [["reshare", true], ["post", false]]);
});

test("items whose account was removed still show up", () => {
  const list = todos([post("orphan", { status: "failed", account_id: null })], [page, founder], NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0].account, null);
  assert.equal(list[0].reconnect, false);
});

test("nothing to do gives an empty list", () => {
  assert.deepEqual(todos([post("a", {}), post("b", { status: "planned" })], [page], NOW), []);
});
