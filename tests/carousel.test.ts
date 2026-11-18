import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from "pdf-lib";
import { buildCarouselPdf } from "../src/lib/carousel";
import type { Slide } from "../src/lib/posts";

const SLIDES: Slide[] = [
  { kind: "cover", title: "How we pick a roast date", body: "Three things we check before every batch." },
  { kind: "point", title: "We cup every batch.", quote: "“Too bright. One more minute.”", quoteLabel: "Tuesday's tasting notes", body: "If it doesn't taste right, it doesn't ship." },
  { kind: "point", title: "We roast to order.", body: "Nothing sits on a shelf for weeks." },
  { kind: "end", title: "What's your go-to brew?", body: "Tell us in the comments." },
];

/** A folder with no fonts and no logo, so the build is the same wherever the tests run. */
function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "carousel-"));
}

/** A page's drawing operators, decoded. */
function pageOps(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents];
  return streams.filter((s): s is PDFRawStream => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
}

/** The text drawn on a page (the fallback Helvetica writes it as hex strings: <48656c6c6f> Tj). */
function pageText(page: PDFPage): string {
  return [...pageOps(page).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
}

/**
 * Rectangles drawn on a page. pdf-lib draws each as a closed path (m, l, l, l, then "h"); circles use curves and
 * never close with "h". The cover slide draws only its background, plus a box when there's a logo.
 */
const rectangles = (page: PDFPage) => pageOps(page).match(/^h$/gm)?.length ?? 0;

const imageCount = (page: PDFPage) => page.node.Resources()?.lookup(PDFName.of("XObject"))?.toString().match(/Image/g)?.length ?? 0;

test("buildCarouselPdf renders one 1080x1350 page per slide", async () => {
  const bytes = await buildCarouselPdf(SLIDES, { name: "Acme Coffee Roasters", label: "Roasting", root: emptyRoot() });
  if (process.env.WRITE_PDF) writeFileSync(process.env.WRITE_PDF, bytes);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 4);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 1080);
  assert.equal(height, 1350);
});

test("every slide is headed with whoever publishes it, and nothing names the tool", async () => {
  const bytes = await buildCarouselPdf(SLIDES, { name: "Acme Coffee Roasters", label: "Roasting", root: emptyRoot() });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getAuthor(), "Acme Coffee Roasters");
  const pages = doc.getPages().map(pageText);
  for (const [i, text] of pages.entries()) {
    assert.match(text, /^Acme Coffee Roasters$/m, `slide ${i + 1} header`);
    assert.doesNotMatch(text, /Post Desk|example\.com/, `slide ${i + 1}`);
  }
  assert.match(pages[0], /^Swipe ->$/m);
  assert.match(pages[3], /^Roasting$/m, "the last slide's footer is the deck's label");
});

test("no logo means no empty logo box; a provided logo is used", async () => {
  const plain = await PDFDocument.load(await buildCarouselPdf(SLIDES, { name: "Acme", label: "x", root: emptyRoot() }));
  assert.equal(imageCount(plain.getPage(0)), 0);
  assert.equal(rectangles(plain.getPage(0)), 1, "just the background: no empty box where a logo would go");

  const root = emptyRoot();
  mkdirSync(join(root, "public"));
  // 1x1 PNG
  writeFileSync(join(root, "public", "logo-mark.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const withLogo = await PDFDocument.load(await buildCarouselPdf(SLIDES, { name: "Acme", label: "x", root }));
  assert.equal(imageCount(withLogo.getPage(0)), 1);
  assert.equal(rectangles(withLogo.getPage(0)), 2, "background and the logo's box");
});

test("with no usable name, slides carry no name at all", async () => {
  const doc = await PDFDocument.load(await buildCarouselPdf(SLIDES, { name: null, label: "Roasting", root: emptyRoot() }));
  assert.equal(doc.getAuthor(), undefined);
  const cover = pageText(doc.getPage(0));
  assert.deepEqual(cover.split("\n").filter(Boolean).slice(0, 2), ["How we pick a", "roast date"], "the title is the first text");
  assert.doesNotMatch(cover, /urn:li|My company|Post Desk/);
});

test("slides use the workspace's carousel color", async () => {
  const fill = (hex: string) => [1, 3, 5].map((i) => String(parseInt(hex.slice(i, i + 2), 16) / 255)).join(" ") + " rg";
  const blue = await PDFDocument.load(await buildCarouselPdf(SLIDES, { name: "Acme", label: "x", color: "#1E3A8A", root: emptyRoot() }));
  assert.ok(pageOps(blue.getPage(0)).includes(fill("#1E3A8A")), "cover background in the chosen color");
  const neutral = await PDFDocument.load(await buildCarouselPdf(SLIDES, { name: "Acme", label: "x", root: emptyRoot() }));
  assert.ok(pageOps(neutral.getPage(0)).includes(fill("#334155")), "neutral slate by default");
  assert.ok(!pageOps(neutral.getPage(0)).includes(fill("#073C40")), "never the tool's own teal");
});
