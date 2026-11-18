// Builds a branded 1080x1350 carousel PDF (LinkedIn document post) from slide data.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Slide } from "./posts";

const W = 1080, H = 1350, PAD = 96;

function hex(h: string): RGB {
  const n = parseInt(h.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Default carousel brand (matches src/app/globals.css)
export const BRAND = {
  name: "Post Desk",
  teal: "#073C40",
  ink: "#0F172A",
  paper: "#F8FAFC",
  mint: "#EAF5E6",
  green: "#7DC271",
  leaf: "#1C7D5A",
  soft: "#475569",
  line: "#E2E8F0",
  onDark: "#CFE3E1",
  onDarkSoft: "#9FC4C1",
  accentOnDark: "#A8D99B",
  site: "example.com",
};

type Fonts = { display: PDFFont; body: PDFFont; semi: PDFFont };

async function loadFonts(pdf: PDFDocument, root: string): Promise<Fonts> {
  try {
    const fontkit = (await import("@pdf-lib/fontkit")).default;
    pdf.registerFontkit(fontkit);
    const [d, b, s] = await Promise.all(
      ["InterDisplay-Bold.otf", "Inter-Regular.otf", "Inter-SemiBold.otf"].map((f) => readFile(join(root, "public", "fonts", f))),
    );
    return { display: await pdf.embedFont(d, { subset: true }), body: await pdf.embedFont(b, { subset: true }), semi: await pdf.embedFont(s, { subset: true }) };
  } catch {
    // Fallback when fontkit or the font files aren't available.
    return {
      display: await pdf.embedFont(StandardFonts.HelveticaBold),
      body: await pdf.embedFont(StandardFonts.Helvetica),
      semi: await pdf.embedFont(StandardFonts.HelveticaBold),
    };
  }
}

/** Standard fonts can't encode curly quotes etc.; normalise so the fallback never throws. */
function clean(text: string, font: PDFFont): string {
  try { font.encodeText(text); return text; } catch {
    return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7E\n]/g, "");
  }
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth || !line) line = test;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

/** Draws wrapped text top-down from y (top edge); returns the new y below the block. */
function block(page: PDFPage, text: string, o: { font: PDFFont; size: number; y: number; color: RGB; lineHeight?: number; maxWidth?: number; x?: number }): number {
  const lh = o.size * (o.lineHeight ?? 1.25);
  const lines = wrap(clean(text, o.font), o.font, o.size, o.maxWidth ?? W - PAD * 2);
  let y = o.y;
  for (const l of lines) {
    y -= lh;
    page.drawText(l, { x: o.x ?? PAD, y: y + (lh - o.size) * 0.5, size: o.size, font: o.font, color: o.color });
  }
  return y;
}

export async function buildCarouselPdf(slides: Slide[], opts: { label: string; root?: string }): Promise<Uint8Array> {
  const root = opts.root ?? process.cwd();
  const pdf = await PDFDocument.create();
  pdf.setTitle(slides[0]?.title || opts.label);
  pdf.setAuthor(BRAND.name);
  const f = await loadFonts(pdf, root);
  let logo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  try { logo = await pdf.embedPng(await readFile(join(root, "public", "logo-mark.png"))); } catch { logo = null; }

  let pointNo = 0;
  slides.forEach((s, i) => {
    const page = pdf.addPage([W, H]);
    const dark = s.kind !== "point";
    const tinted = s.kind === "point" && pointNo % 2 === 1;
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(dark ? BRAND.teal : tinted ? BRAND.mint : BRAND.paper) });
    if (dark) page.drawCircle({ x: i === 0 ? W + 20 : -40, y: -40, size: 300, color: hex(BRAND.green), opacity: 0.16 });

    // Brand row
    const top = H - 90;
    page.drawRectangle({ x: PAD, y: top - 58, width: 58, height: 58, color: hex("#FFFFFF"), borderColor: hex(BRAND.line), borderWidth: dark ? 0 : 1 });
    if (logo) page.drawImage(logo, { x: PAD + 6, y: top - 52, width: 46, height: 46 });
    page.drawText(BRAND.name, { x: PAD + 74, y: top - 40, size: 32, font: f.display, color: hex(dark ? BRAND.paper : BRAND.ink) });

    let y = top - 150;
    if (s.kind === "point") {
      pointNo++;
      const label = String(pointNo).padStart(2, "0");
      const lw = f.semi.widthOfTextAtSize(label, 30) + 52;
      page.drawRectangle({ x: PAD, y: y - 56, width: lw, height: 56, color: hex(tinted ? BRAND.leaf : BRAND.teal) });
      page.drawText(label, { x: PAD + 26, y: y - 39, size: 30, font: f.semi, color: hex("#FFFFFF") });
      y -= 100;
      y = block(page, s.title, { font: f.display, size: 84, y, color: hex(BRAND.ink), lineHeight: 1.08 });
      if (s.quote) {
        y -= 44;
        const qLines = wrap(clean(s.quote, f.body), f.body, 40, W - PAD * 2 - 80);
        const boxH = (s.quoteLabel ? 40 : 0) + qLines.length * 54 + 68;
        page.drawRectangle({ x: PAD, y: y - boxH, width: W - PAD * 2, height: boxH, color: hex("#FFFFFF"), borderColor: hex(BRAND.line), borderWidth: 2 });
        let qy = y - 34;
        if (s.quoteLabel) { page.drawText(clean(s.quoteLabel.toUpperCase(), f.semi), { x: PAD + 40, y: qy - 22, size: 22, font: f.semi, color: hex(BRAND.soft) }); qy -= 40; }
        block(page, s.quote, { font: f.body, size: 40, y: qy, color: hex(BRAND.ink), lineHeight: 1.35, x: PAD + 40, maxWidth: W - PAD * 2 - 80 });
        y -= boxH;
      }
      if (s.body) { y -= 36; block(page, s.body, { font: f.body, size: 42, y, color: hex(BRAND.soft), lineHeight: 1.4 }); }
    } else {
      y -= 70;
      y = block(page, s.title, { font: f.display, size: s.kind === "cover" ? 100 : 96, y, color: hex(BRAND.paper), lineHeight: 1.04 });
      if (s.body) { y -= 40; block(page, s.body, { font: f.body, size: 40, y, color: hex(BRAND.onDark), lineHeight: 1.35 }); }
    }

    // Footer: label and page dots
    const footY = 80;
    const left = s.kind === "cover" ? "Swipe ->" : s.kind === "end" ? BRAND.site : opts.label;
    page.drawText(clean(left, f.semi), { x: PAD, y: footY, size: 26, font: f.semi, color: hex(s.kind === "cover" ? BRAND.accentOnDark : dark ? BRAND.onDarkSoft : BRAND.soft) });
    const n = slides.length;
    for (let d = 0; d < n; d++) {
      page.drawCircle({ x: W - PAD - (n - 1 - d) * 24, y: footY + 9, size: 7, color: hex(dark ? BRAND.paper : BRAND.ink), opacity: d === i ? 1 : 0.25 });
    }
  });

  return pdf.save();
}
