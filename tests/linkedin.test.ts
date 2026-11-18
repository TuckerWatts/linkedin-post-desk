// createPost's failure modes and mayHaveCreated(), which decides whether a failed create could still have posted.
// No network: fetch is replaced by a fake that returns canned responses.
import { fetchFailed, timedOut } from "./offline";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createPost, LinkedInError, mayHaveCreated } from "../src/lib/linkedin";

const offline = globalThis.fetch;
afterEach(() => { globalThis.fetch = offline; });
const respond = (status: number, headers: Record<string, string> = {}, body: string | null = null) => {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as typeof fetch;
};
const input = { author: "urn:li:organization:1", text: "Hi" };

async function failure(): Promise<unknown> {
  try { await createPost("token", input); } catch (e) { return e; }
  assert.fail("createPost should have thrown");
}

test("createPost returns the new post's id", async () => {
  respond(201, { "x-restli-id": "urn:li:share:1" });
  assert.equal(await createPost("token", input), "urn:li:share:1");
});

test("a 2xx without an id means the post exists: mayHaveCreated", async () => {
  respond(201);
  const e = await failure();
  assert.ok(e instanceof LinkedInError);
  assert.equal(e.message, "LinkedIn created the post but returned no id");
  assert.equal(mayHaveCreated(e), true);
});

test("error statuses, including 404, are reported as failures and didn't create anything", async () => {
  for (const status of [400, 404, 422, 429, 500, 503]) {
    respond(status, {}, `{"message":"status ${status}"}`);
    const e = await failure();
    assert.ok(e instanceof LinkedInError);
    assert.equal(e.message, `LinkedIn POST /rest/posts failed (${status})`, "a 404 used to say 'created the post'");
    assert.equal(mayHaveCreated(e), false, `status ${status}`);
  }
});

test("a gateway timeout or bad gateway (504, 502) may hide a created post, like a timeout", async () => {
  for (const status of [502, 504]) {
    respond(status, {}, "<html>Gateway error</html>");
    const e = await failure();
    assert.ok(e instanceof LinkedInError);
    assert.equal(mayHaveCreated(e), true, `status ${status}`);
  }
});

test("network errors: only a connection that never opened rules out a new post", async () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(mayHaveCreated(fetchFailed(code)), false, code);
  }
  const refusedEverywhere = new TypeError("fetch failed", {
    cause: new AggregateError([fetchFailed("ECONNREFUSED").cause, fetchFailed("ECONNREFUSED").cause]) });
  assert.equal(mayHaveCreated(refusedEverywhere), false, "every address refused");

  for (const code of ["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "EPIPE", "ETIMEDOUT", "SOMETHING_NEW"]) {
    assert.equal(mayHaveCreated(fetchFailed(code)), true, code);
  }
  assert.equal(mayHaveCreated(timedOut()), true, "timed out waiting for the answer");
  assert.equal(mayHaveCreated(new TypeError("fetch failed")), true, "no cause: unknown, so assume it may have posted");
  const mixed = new TypeError("fetch failed", {
    cause: new AggregateError([fetchFailed("ECONNREFUSED").cause, fetchFailed("ECONNRESET").cause]) });
  assert.equal(mayHaveCreated(mixed), true, "one address may have received it");

  globalThis.fetch = (async () => { throw fetchFailed("UND_ERR_SOCKET", "other side closed"); }) as typeof fetch;
  assert.equal(mayHaveCreated(await failure()), true, "createPost passes network errors through unchanged");
});
