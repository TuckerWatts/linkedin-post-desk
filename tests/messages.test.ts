// Guard: messages written to be shown to people as they are must read as plain language. Scans the source for
// UserError messages and the dashboard's own pop-up messages, and fails on technical words or on internal values
// (a status, a kind, an error) pasted into the sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** [file, message] for every string passed to new UserError(...), say(...), or as the message of act(..., "..."). */
function shownMessages(): [string, string][] {
  const out: [string, string][] = [];
  for (const f of files(join(__dirname, "..", "src"))) {
    const src = readFileSync(f, "utf8");
    const patterns = [
      /new UserError\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
      /\bsay\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
      /\bact\([^;]*?\},\s*(["'`])((?:\\.|(?!\1).)*)\1\)/g,
    ];
    for (const re of patterns) for (const m of src.matchAll(re)) out.push([f.split("/src/")[1], m[2]]);
  }
  return out;
}

const TECHNICAL = /\b(HTTP|JSON|API|URN|null|undefined|exception|stack trace|status code|env|\d{3} error)\b|urn:li|ANTHROPIC|LINKEDIN_|GITHUB|[A-Z]+_KEY\b/;
const PASTED_VALUE = /\$\{[^}]*\b(status|kind|error|err|e\.message|code)\b[^}]*\}/;

test("messages shown as they are contain no technical words or pasted internal values", () => {
  const messages = shownMessages();
  assert.ok(messages.length > 25, `found ${messages.length} messages; the scan may be broken`);
  const bad = messages.filter(([, m]) => TECHNICAL.test(m) || PASTED_VALUE.test(m));
  assert.deepEqual(bad, []);
});

test("the guard does catch the kind of message it's for", () => {
  for (const m of ["Can't approve a ${post.status} post.", "LinkedIn API error 500", "Request failed: ${e.message}", "Set ANTHROPIC_API_KEY first"]) {
    assert.ok(TECHNICAL.test(m) || PASTED_VALUE.test(m), m);
  }
});
