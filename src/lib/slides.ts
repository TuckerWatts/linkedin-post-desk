// Rules for carousel slides written or edited by hand. Pure, so the editor and the server share them.
import { UserError } from "./errors";
import type { Slide } from "./posts";

export const MAX_POINTS = 10;
/** Longer text wouldn't fit on a 1080×1350 slide at the sizes carousel.ts uses. */
export const LIMITS = { title: 90, body: 280, quote: 240, quoteLabel: 60, deck: 60 } as const;

/** "Cover", "Point 2", "Closing slide": how the editor and messages refer to a slide. */
export function slideLabel(slides: Pick<Slide, "kind">[], i: number): string {
  const s = slides[i];
  if (s.kind === "cover") return "Cover";
  if (s.kind === "end") return "Closing slide";
  return `Point ${slides.slice(0, i + 1).filter((x) => x.kind === "point").length}`;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/[ \t]+/g, " ") : "");

/**
 * Checks slides before they're saved and tidies them (trims text, drops empty optional fields). A carousel is a cover,
 * 1 to MAX_POINTS points, and a closing slide, each with a title. Messages say which slide needs attention.
 */
export function cleanSlides(input: unknown): Slide[] {
  if (!Array.isArray(input) || !input.length) throw new UserError("Add some slides first.");
  const kinds = input.map((s) => (s as Slide)?.kind);
  const points = kinds.filter((k) => k === "point").length;
  const shapeOk = points >= 1 && kinds[0] === "cover" && kinds[kinds.length - 1] === "end" && kinds.length === points + 2;
  if (!shapeOk) throw new UserError("A carousel needs a cover, at least one point, and a closing slide.");
  if (points > MAX_POINTS) throw new UserError(`A carousel can have up to ${MAX_POINTS} points.`);

  return input.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    const label = slideLabel(input as Slide[], i);
    const out: Slide = { kind: kinds[i] as Slide["kind"], title: text(s.title) };
    if (!out.title) throw new UserError(`${label} needs a title.`);
    if (out.title.length > LIMITS.title) throw new UserError(`${label}'s title is too long. Keep it under ${LIMITS.title} characters.`);
    const body = text(s.body);
    if (body.length > LIMITS.body) throw new UserError(`${label}'s text is too long. Keep it under ${LIMITS.body} characters.`);
    if (body) out.body = body;
    if (out.kind === "point") {
      const quote = text(s.quote);
      if (quote.length > LIMITS.quote) throw new UserError(`${label}'s quote is too long. Keep it under ${LIMITS.quote} characters.`);
      if (quote) {
        out.quote = quote;
        const quoteLabel = text(s.quoteLabel);
        if (quoteLabel.length > LIMITS.quoteLabel) throw new UserError(`${label}'s quote label is too long. Keep it under ${LIMITS.quoteLabel} characters.`);
        if (quoteLabel) out.quoteLabel = quoteLabel;
      }
    }
    return out;
  });
}

/** The deck title shown at the bottom of the slides; falls back to the post's topic. */
export function cleanDeckTitle(input: unknown, fallback: string): string {
  const t = text(input) || fallback.trim() || "Carousel";
  if (t.length > LIMITS.deck) throw new UserError(`Keep the deck title under ${LIMITS.deck} characters.`);
  return t;
}

/**
 * Slides to start from when turning a text draft into a carousel: a cover titled from the draft, one point and a
 * closing slide. Only the cover has a title, so nothing can be saved (or published) until the rest are written.
 */
export function starterSlides(topic: string, body: string): Slide[] {
  const firstLine = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const title = (topic.trim() && topic.trim() !== "Untitled" ? topic.trim() : firstLine).slice(0, LIMITS.title);
  return [{ kind: "cover", title }, { kind: "point", title: "" }, { kind: "end", title: "" }];
}
