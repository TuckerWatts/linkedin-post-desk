// What the dashboard receives for each post: plain explanations, and no technical error text at all.
import "./offline";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "../src/lib/accounts";
import { forDashboard, type Post } from "../src/lib/posts";

const page = { id: "page", kind: "organization", name: "Acme" } as Account;
const founder = { id: "founder", kind: "person", name: "Sam" } as Account;
const TECHNICAL = [
  'LinkedIn POST /rest/posts failed (401): {"message":"The token used in the request has expired"}',
  "fetch failed (other side closed)",
  "connection terminated unexpectedly",
  "The run stopped after the request was sent to LinkedIn, before its answer was saved.",
];

test("posts sent to the dashboard carry plain explanations and none of the technical messages", () => {
  const posts: Post[] = [
    { id: "a", status: "failed", attempts: 1, account_id: "page", reshare_account_id: "founder", reshare_status: "none",
      error: TECHNICAL[1], error_kind: "maybe_live", reshare_error: null, reshare_error_kind: null } as Post,
    { id: "b", status: "posted", attempts: 1, account_id: "page", reshare_account_id: "founder", reshare_status: "failed",
      error: null, error_kind: null, reshare_error: TECHNICAL[0], reshare_error_kind: "reconnect" } as Post,
    { id: "c", status: "planned", attempts: 1, account_id: "page", reshare_account_id: null, reshare_status: "none",
      error: TECHNICAL[2], error_kind: "other", reshare_error: null, reshare_error_kind: null } as Post,
    { id: "d", status: "failed", attempts: 1, account_id: "page", reshare_account_id: null, reshare_status: "none",
      error: TECHNICAL[3], error_kind: "maybe_live", reshare_error: null, reshare_error_kind: null } as Post,
  ];
  const out = posts.map((p) => forDashboard(p, [page, founder]));
  assert.deepEqual(out.map((p) => [p.problem, p.reshare_problem]), [
    ["This post may already be on LinkedIn, but the app couldn't confirm it. Check the page: if it's there, use Mark posted; if not, press Retry.", null],
    [null, "LinkedIn rejected Sam's connection. Reconnect it, then retry."],
    ["Something went wrong before this post was sent. It will retry automatically.", null],
    ["This post may already be on LinkedIn, but the app couldn't confirm it. Check the page: if it's there, use Mark posted; if not, press Retry.", null],
  ]);
  const json = JSON.stringify(out);
  for (const t of TECHNICAL) assert.ok(!json.includes(JSON.stringify(t).slice(1, -1)), `leaked: ${t}`);
  assert.ok(out.every((p) => p.error === null && p.reshare_error === null));
});
