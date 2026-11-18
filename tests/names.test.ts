// The names shown for accounts and printed on carousels: never an ID, a placeholder or a blank.
import "./offline";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { withShownName, type Account } from "../src/lib/accounts";
import { UserError } from "../src/lib/errors";
import { getAdminOrganizations } from "../src/lib/linkedin";
import { cleanDisplayName, DEFAULT_WORKSPACE_NAME, looksLikeId, publisherName } from "../src/lib/names";

test("looksLikeId spots LinkedIn IDs and bare numbers, not names", () => {
  for (const id of ["urn:li:organization:1234567", "URN:LI:person:abc", " 1234567 ", "Page urn:li:organization:1"]) assert.equal(looksLikeId(id), true, id);
  for (const name of ["Acme Coffee Roasters", "Alex Rivera", "7-Eleven", "3M", "Studio 54"]) assert.equal(looksLikeId(name), false, name);
});

test("publisherName takes the first real name, and otherwise none", () => {
  assert.equal(publisherName("Acme Coffee Roasters"), "Acme Coffee Roasters");
  assert.equal(publisherName("urn:li:organization:1234567", "Acme"), "Acme", "skips an ID");
  assert.equal(publisherName(null, DEFAULT_WORKSPACE_NAME), null, "never prints the 'My company' placeholder");
  assert.equal(publisherName(undefined, "   ", "urn:li:organization:1"), null);
  assert.equal(publisherName("  Acme  "), "Acme");
});

test("cleanDisplayName accepts real names and refuses IDs", () => {
  assert.equal(cleanDisplayName("  Acme   Coffee "), "Acme Coffee");
  assert.equal(cleanDisplayName(""), null, "blank means: go back to LinkedIn's name");
  assert.equal(cleanDisplayName(null), null);
  assert.throws(() => cleanDisplayName("urn:li:organization:1234567"), (e) => e instanceof UserError && /name people know/.test(e.message));
  assert.throws(() => cleanDisplayName("x".repeat(101)), UserError);
});

test("the shown name: a chosen name wins, and an ID is never shown", () => {
  const row = (o: Partial<Account>) => ({ id: "a", workspace_id: "w", kind: "organization", urn: "urn:li:organization:1",
    linkedin_name: "Acme Coffee Roasters", display_name: null, profile_url: null, token_expires_at: null, is_default: true,
    is_reshare_default: false, connected: true, reconnect_needed_at: null, ...o }) as Omit<Account, "name" | "name_missing">;
  assert.deepEqual([withShownName(row({})).name, withShownName(row({})).name_missing], ["Acme Coffee Roasters", false]);
  assert.equal(withShownName(row({ display_name: "Acme" })).name, "Acme");
  const legacy = withShownName(row({ linkedin_name: "urn:li:organization:1" }));
  assert.deepEqual([legacy.name, legacy.name_missing], ["Unnamed page", true]);
  assert.equal(withShownName(row({ kind: "person", linkedin_name: "urn:li:person:x" })).name, "Unnamed profile");
  assert.deepEqual([withShownName(row({ linkedin_name: "urn:li:organization:1", display_name: "Acme" })).name_missing], [false], "renamed");
});

const offline = globalThis.fetch;
afterEach(() => { globalThis.fetch = offline; });

test("a company page whose name LinkedIn doesn't give comes back nameless, never named by its ID", async () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/rest/organizationAcls")) {
      return json(200, { elements: [1, 2, 3, 4].map((n) => ({ organization: `urn:li:organization:${n}` })) });
    }
    if (u.endsWith("/rest/organizations/1")) return json(200, { localizedName: "Acme Coffee Roasters", vanityName: "acme" });
    if (u.endsWith("/rest/organizations/2")) return json(403, { message: "Not enough permissions" });
    if (u.endsWith("/rest/organizations/3")) return json(404, { message: "Not found" });
    if (u.endsWith("/rest/organizations/4")) return json(200, { vanityName: "nameless" });
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  const orgs = await getAdminOrganizations("token");
  assert.deepEqual(orgs.map((o) => [o.urn, o.name]), [
    ["urn:li:organization:1", "Acme Coffee Roasters"],
    ["urn:li:organization:2", null],
    ["urn:li:organization:3", null],
    ["urn:li:organization:4", null],
  ]);
});
