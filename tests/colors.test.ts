import { test } from "node:test";
import assert from "node:assert/strict";
import { carouselPalette, contrast, DEFAULT_CAROUSEL_COLOR, isHexColor } from "../src/lib/colors";

/** Every text-on-background pair the carousel draws, with the contrast it needs (WCAG: 4.5 for text). */
const PAIRS: [keyof ReturnType<typeof carouselPalette>, keyof ReturnType<typeof carouselPalette>, number][] = [
  ["onDarkTitle", "dark", 7],  // titles on cover and end slides
  ["onDark", "dark", 4.5],     // body text on dark slides
  ["onDarkSoft", "dark", 4.5], // footer on dark slides
  ["accentOnDark", "dark", 4.5], // "Swipe ->"
  ["ink", "tint", 7],          // titles on tinted point slides
  ["soft", "tint", 4.5],       // body text on tinted point slides
  ["ink", "paper", 7],
  ["soft", "paper", 4.5],
  ["badgeText", "dark", 4.5],  // the number in the badge
];

test("any color gives readable slides", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const colors = ["#FFFFFF", "#000000", "#FACC15", "#FFFF00", "#00FF00", "#FFC0CB", "#F8FAFC", "#7DC271", "#808080",
    ...Array.from({ length: 600 }, () => "#" + Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0"))];
  for (const c of colors) {
    const p = carouselPalette(c);
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(contrast(p[fg], p[bg]) >= min, `${c}: ${fg} ${p[fg]} on ${bg} ${p[bg]} is ${contrast(p[fg], p[bg]).toFixed(2)}`);
    }
  }
});

test("dark and light brand colors are used exactly as picked, with text to suit", () => {
  const navy = carouselPalette("#1E3A8A");
  assert.deepEqual([navy.dark, navy.onDarkTitle], ["#1E3A8A", "#F8FAFC"], "light text on a dark color");
  assert.equal(carouselPalette("#1e3a8a").dark, "#1E3A8A", "case doesn't matter");
  const yellow = carouselPalette("#FACC15");
  assert.deepEqual([yellow.dark, yellow.onDarkTitle], ["#FACC15", "#0F172A"], "a yellow stays yellow, with dark text");
});

test("a mid-tone that suits neither light nor dark text is deepened just enough", () => {
  const blue = carouselPalette("#3B82F6");
  assert.notEqual(blue.dark, "#3B82F6");
  assert.equal(blue.onDarkTitle, "#F8FAFC");
  assert.ok(contrast("#F8FAFC", blue.dark) < 9, "only as far as needed, not to black");
});

test("no color chosen means a neutral slate, not the tool's own teal", () => {
  assert.equal(carouselPalette(null).dark, DEFAULT_CAROUSEL_COLOR);
  assert.equal(carouselPalette("not a color").dark, DEFAULT_CAROUSEL_COLOR);
  assert.ok(!Object.values(carouselPalette(null)).some((c) => ["#073C40", "#7DC271", "#EAF5E6", "#1C7D5A"].includes(c)));
  assert.equal(isHexColor("#12abEF"), true);
  assert.equal(isHexColor("red"), false);
});
