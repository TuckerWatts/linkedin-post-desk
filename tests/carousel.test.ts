import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { buildCarouselPdf } from "../src/lib/carousel";

test("buildCarouselPdf renders one 1080x1350 page per slide", async () => {
  const bytes = await buildCarouselPdf([
    { kind: "cover", title: "4 habits for family communication", body: "No new system required." },
    { kind: "point", title: "Send good news without being asked.", quote: "“Shared their snack with a friend today.”", quoteLabel: "A random text at 11am", body: "Builds more trust than any newsletter." },
    { kind: "point", title: "Hard news gets a phone call.", body: "Not a text. Not a note in the cubby." },
    { kind: "end", title: "Which one is hardest for your center?", body: "Tell us in the comments." },
  ], { label: "Family communication" });
  if (process.env.WRITE_PDF) writeFileSync(process.env.WRITE_PDF, bytes);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 4);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(width, 1080);
  assert.equal(height, 1350);
});
