import { test } from "node:test";
import assert from "node:assert/strict";
import { findTells } from "../src/lib/tells";
import { nextSlot, planSlots } from "../src/lib/slots";
import { zonedParts, zonedTime } from "../src/lib/time";
import { buildPostBody, toLittleText } from "../src/lib/linkedin";
import { decrypt, encrypt, sign, unsign } from "../src/lib/crypto";
import { extractJson } from "../src/lib/anthropic";

const TZ = "America/New_York";

test("findTells flags em dashes, buzzwords, links and hashtag spam", () => {
  assert.deepEqual(findTells("The new roast takes about four minutes longer."), []);
  const t = findTells("We're excited to announce a seamless journey — #a #b #c https://x.co");
  assert.ok(t.includes("em dashes"));
  assert.ok(t.includes('"excited to announce"'));
  assert.ok(t.includes('"seamless"'));
  assert.ok(t.includes("more than 2 hashtags"));
  assert.ok(t.some((x) => x.startsWith("link")));
  assert.deepEqual(findTells("A journeyman electrician"), [], "matches whole words only");
});

test("zonedTime round-trips across DST", () => {
  const d = zonedTime(2026, 11, 2, 7, 20, TZ); // after DST ends (EST, UTC-5)
  assert.equal(d.toISOString(), "2026-11-02T12:20:00.000Z");
  const s = zonedTime(2026, 10, 14, 12, 20, TZ); // EDT, UTC-4
  assert.equal(s.toISOString(), "2026-10-14T16:20:00.000Z");
  const p = zonedParts(d, TZ);
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 11, 2, 7, 20]);
});

test("nextSlot is 2-3 days after the latest planned post, never Sunday, at a listed time", () => {
  const now = new Date("2026-10-08T15:00:00Z");
  for (let i = 0; i < 50; i++) {
    const taken = [new Date("2026-10-20T12:30:00Z")];
    const s = nextSlot(taken, `seed-${i}`, TZ, now);
    const days = (s.getTime() - taken[0].getTime()) / 86400000;
    assert.ok(days > 1 && days < 6, `gap ${days}`);
    const p = zonedParts(s, TZ);
    assert.notEqual(p.weekday, 0);
    assert.notEqual(p.minute % 30, 0, "avoids :00 and :30");
  }
  assert.equal(nextSlot([], "x", TZ, now).getTime() > now.getTime(), true);
  const plan = planSlots(5, [], ["a", "b", "c", "d", "e"], TZ, now);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i] > plan[i - 1]);
});

test("toLittleText escapes reserved characters and keeps hashtags", () => {
  assert.equal(toLittleText("Brew ratio (1:16) @ 5pm"), "Brew ratio \\(1:16\\) \\@ 5pm");
  assert.equal(toLittleText("Go #coffee!"), "Go {hashtag|\\#|coffee}!");
  assert.equal(toLittleText("a_b*c"), "a\\_b\\*c");
});

test("buildPostBody shapes text, document and reshare posts", () => {
  const text = buildPostBody({ author: "urn:li:organization:1", text: "Hi" });
  assert.equal(text.visibility, "PUBLIC");
  assert.equal(text.lifecycleState, "PUBLISHED");
  assert.equal("content" in text, false);
  const doc = buildPostBody({ author: "urn:li:organization:1", text: "Hi", document: { urn: "urn:li:document:9", title: "Deck" } });
  assert.deepEqual(doc.content, { media: { title: "Deck", id: "urn:li:document:9" } });
  const rs = buildPostBody({ author: "urn:li:person:2", text: "", reshareOf: "urn:li:share:3" });
  assert.deepEqual(rs.reshareContext, { parent: "urn:li:share:3" });
});

test("encrypt/decrypt and sign/unsign", () => {
  const secret = "x".repeat(44);
  assert.equal(decrypt(encrypt("token-123", secret), secret), "token-123");
  assert.throws(() => decrypt(encrypt("t", secret), "y".repeat(44)));
  const s = sign("admin:123", secret);
  assert.equal(unsign(s, secret), "admin:123");
  assert.equal(unsign(s.slice(0, -1) + (s.endsWith("A") ? "B" : "A"), secret), null);
});

test("extractJson tolerates fences and prose", () => {
  assert.deepEqual(extractJson<number[]>("Sure:\n```json\n[1,2]\n```"), [1, 2]);
  assert.deepEqual(extractJson<{ a: string }>('Here {"a":"b}"} done'), { a: "b}" });
});

test("built-in drafting rules don't assume any particular business or audience", async () => {
  const { BASE_RULES } = await import("../src/lib/drafting");
  assert.doesNotMatch(BASE_RULES, /parent|famil|child|daycare|director|staff|fear|guilt/i);
  assert.match(BASE_RULES, /voice and audience notes/i, "points the model at the workspace's own notes");
  assert.match(BASE_RULES, /Don't assume anyone's gender/);
});

test("suggested times stay within the chosen times of day", async () => {
  const { POSTING_WINDOWS, cleanWindows, nextSlot, slotTimes } = await import("../src/lib/slots");
  const now = new Date("2026-10-08T15:00:00Z");
  for (const windows of [["early"], ["evening"], ["morning", "afternoon"], ["midday"]] as const) {
    const allowed = new Set(windows.flatMap((w) => POSTING_WINDOWS[w].times.map(([h, m]) => `${h}:${m}`)));
    for (let i = 0; i < 40; i++) {
      const p = zonedParts(nextSlot([], `seed-${i}`, TZ, now, slotTimes(windows)), TZ);
      assert.ok(allowed.has(`${p.hour}:${p.minute}`), `${windows}: ${p.hour}:${p.minute}`);
      assert.notEqual(p.minute % 30, 0);
      assert.notEqual(p.weekday, 0, "never on a Sunday");
    }
  }
  assert.deepEqual(slotTimes([]), slotTimes(), "nothing valid picked: the default (morning and midday)");
  assert.deepEqual(slotTimes(["nonsense"]), slotTimes());
  assert.ok(slotTimes().every(([h]) => h >= 8 && h < 14), "the default is business hours, not early morning");

  assert.deepEqual(cleanWindows(["evening", "early", "bogus"]), ["early", "evening"]);
  assert.throws(() => cleanWindows([]), /Pick at least one time of day/);
  assert.throws(() => cleanWindows("morning"), /Pick at least one time of day/);
});

test("time zone choices read as cities with their offset, grouped by region", async () => {
  const { timeZoneOptions } = await import("../src/lib/time");
  const groups = timeZoneOptions("America/New_York", new Date("2026-01-15T12:00:00Z"));
  const america = groups.find((g) => g.region === "America")!;
  assert.deepEqual(america.options.find((o) => o.value === "America/New_York"), { value: "America/New_York", label: "New York (GMT-5)" });
  assert.ok(america.options.some((o) => o.label.startsWith("Buenos Aires")), "underscores become spaces");
  assert.ok(groups.every((g) => g.options.every((o) => !o.label.includes("/") && !o.label.includes("_"))));
  const odd = timeZoneOptions("Etc/GMT+5");
  assert.ok(odd.some((g) => g.options.some((o) => o.value === "Etc/GMT+5")), "the saved zone is always offered");
});
