import { test } from "node:test";
import assert from "node:assert/strict";
import { UserError } from "../src/lib/errors";
import type { Slide } from "../src/lib/posts";
import { cleanDeckTitle, cleanSlides, MAX_POINTS, slideLabel, starterSlides } from "../src/lib/slides";

const deck = (...points: Partial<Slide>[]): Slide[] => [
  { kind: "cover", title: "How we pick a roast date" },
  ...points.map((p, i) => ({ kind: "point" as const, title: `Point ${i + 1}`, ...p })),
  { kind: "end", title: "What's your go-to brew?" },
];
const fails = (slides: unknown, message: RegExp) =>
  assert.throws(() => cleanSlides(slides), (e) => e instanceof UserError && message.test(e.message));

test("a cover, points and a closing slide are saved tidied", () => {
  const out = cleanSlides([
    { kind: "cover", title: "  How we   pick a roast date ", body: "" },
    { kind: "point", title: "We cup every batch.", body: " If it doesn't taste right, it doesn't ship. ", quote: "", quoteLabel: "ignored" },
    { kind: "point", title: "We roast to order.", quote: "Too bright. One more minute.", quoteLabel: "Tuesday's notes" },
    { kind: "end", title: "What's your go-to brew?", extra: "dropped" },
  ]);
  assert.deepEqual(out, [
    { kind: "cover", title: "How we pick a roast date" },
    { kind: "point", title: "We cup every batch.", body: "If it doesn't taste right, it doesn't ship." },
    { kind: "point", title: "We roast to order.", quote: "Too bright. One more minute.", quoteLabel: "Tuesday's notes" },
    { kind: "end", title: "What's your go-to brew?" },
  ]);
});

test("problems are explained in plain words, naming the slide", () => {
  fails([], /Add some slides first/);
  fails("slides", /Add some slides first/);
  fails(deck({ title: "  " }), /^Point 1 needs a title\.$/);
  fails([{ kind: "cover", title: "" }, { kind: "point", title: "x" }, { kind: "end", title: "y" }], /^Cover needs a title\.$/);
  fails(deck({}, {}).map((x) => (x.kind === "end" ? { ...x, title: "" } : x)), /^Closing slide needs a title\.$/);
  fails(deck({}, { title: "x".repeat(91) }), /^Point 2's title is too long/);
  fails(deck({ body: "x".repeat(281) }), /^Point 1's text is too long/);
  fails(deck({ quote: "x".repeat(241) }), /^Point 1's quote is too long/);
  fails([{ kind: "point", title: "x" }, { kind: "end", title: "y" }], /needs a cover, at least one point, and a closing slide/);
  fails([{ kind: "cover", title: "x" }, { kind: "end", title: "y" }], /needs a cover, at least one point/);
  fails(deck(...Array.from({ length: MAX_POINTS + 1 }, () => ({}))), new RegExp(`up to ${MAX_POINTS} points`));
});

test("turning a text draft into a carousel starts from its topic, and can't be saved until written", () => {
  const starter = starterSlides("Why we weigh every shot", "Two grams either way changes the cup.");
  assert.deepEqual(starter, [{ kind: "cover", title: "Why we weigh every shot" }, { kind: "point", title: "" }, { kind: "end", title: "" }]);
  fails(starter, /^Point 1 needs a title\.$/);
  assert.equal(starterSlides("Untitled", "\n  First line here\nmore")[0].title, "First line here", "no real topic: the first line");
});

test("slide labels and the deck title", () => {
  const slides = deck({}, {}, {});
  assert.deepEqual(slides.map((_, i) => slideLabel(slides, i)), ["Cover", "Point 1", "Point 2", "Point 3", "Closing slide"]);
  assert.equal(cleanDeckTitle("  Roasting ", "Topic"), "Roasting");
  assert.equal(cleanDeckTitle("", "Topic"), "Topic");
  assert.throws(() => cleanDeckTitle("x".repeat(61), "Topic"), UserError);
});
