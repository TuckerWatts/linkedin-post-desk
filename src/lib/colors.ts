// Carousel colors from one brand color, always readable. Pure, so Settings can preview them.

/** Used when no carousel color is chosen: a neutral slate that names no brand. */
export const DEFAULT_CAROUSEL_COLOR = "#334155";

const PAPER = "#F8FAFC";
const INK = "#0F172A";
const SOFT = "#475569";
const LINE = "#E2E8F0";
const WHITE = "#FFFFFF";
const BLACK = "#000000";

export function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
}

type RGB = [number, number, number];
const rgbOf = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const hexOf = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();

/** `a` moved towards `b` by t (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a), y = rgbOf(b);
  return hexOf([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * Math.min(1, Math.max(0, t))) as RGB);
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. 4.5 is the minimum for body text, 7 is comfortable. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` moved towards `toward` just far enough to reach `min` contrast against `bg`. */
function readable(color: string, bg: string, min: number, toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(color, toward, t);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}

export type CarouselPalette = {
  dark: string;          // background of cover and end slides, and the number badges: the brand color
  onDarkTitle: string;   // titles, name and page dots on those slides
  onDark: string;        // body text on those slides
  onDarkSoft: string;    // footer text on those slides
  accentOnDark: string;  // "Swipe ->" on the cover
  badgeText: string;     // the number in a badge
  decoration: string;    // the faint circle on those slides
  paper: string;         // background of point slides
  tint: string;          // background of every other point slide
  ink: string;           // titles on light slides
  soft: string;          // body text on light slides
  line: string;          // borders
};

/**
 * The carousel palette for a brand color, always readable:
 *  - a color dark text reads well on (a yellow, say) is used as it is, with dark text;
 *  - a color white text reads well on is used as it is, with light text;
 *  - a mid-tone that suits neither is deepened just enough for light text.
 * Every text color is then checked against its background.
 */
export function carouselPalette(color?: string | null): CarouselPalette {
  const base = isHexColor(color) ? color.toUpperCase() : DEFAULT_CAROUSEL_COLOR;
  const lightBrand = contrast(base, INK) >= 7 && contrast(base, PAPER) < 7;
  const dark = lightBrand ? base : readable(base, PAPER, 7, BLACK);
  const text = lightBrand ? INK : PAPER;        // the text color on brand-colored slides
  const tint = mix(base, WHITE, 0.9);
  return {
    dark,
    onDarkTitle: text,
    onDark: readable(mix(text, dark, 0.15), dark, 4.5, text),
    onDarkSoft: readable(mix(text, dark, 0.35), dark, 4.5, text),
    accentOnDark: lightBrand ? readable(mix(base, BLACK, 0.6), dark, 4.5, INK) : readable(mix(base, WHITE, 0.55), dark, 4.5, WHITE),
    badgeText: text,
    decoration: lightBrand ? mix(base, BLACK, 0.25) : mix(base, WHITE, 0.3),
    paper: PAPER,
    tint,
    ink: INK,
    soft: readable(SOFT, tint, 4.5, INK),
    line: LINE,
  };
}
