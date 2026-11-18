// Picks posting times that look human: 2-3 days apart, mostly weekdays, uneven minutes, within the times of day
// the workspace chose in Settings.
import { UserError } from "./errors";
import { zonedParts, zonedTime } from "./time";

/** Times of day people can pick in Settings. Each has a few uneven minutes (never :00 or :30) to choose from. */
export const POSTING_WINDOWS = {
  early: { label: "Early morning", hint: "6:30–8", times: [[6, 50], [7, 25], [7, 55]] },
  morning: { label: "Morning", hint: "8–11", times: [[8, 40], [9, 20], [10, 10]] },
  midday: { label: "Midday", hint: "11:30–1:30", times: [[11, 55], [12, 25], [13, 10]] },
  afternoon: { label: "Afternoon", hint: "2–5", times: [[14, 20], [15, 35], [16, 35]] },
  evening: { label: "Evening", hint: "6–8", times: [[18, 10], [19, 15], [19, 40]] },
} as const satisfies Record<string, { label: string; hint: string; times: readonly (readonly [number, number])[] }>;

export type PostingWindow = keyof typeof POSTING_WINDOWS;
export const WINDOW_KEYS = Object.keys(POSTING_WINDOWS) as PostingWindow[];
/** Business hours suit most LinkedIn audiences. Must match the column default in db/migrations. */
export const DEFAULT_WINDOWS: PostingWindow[] = ["morning", "midday"];

/** Validates the windows someone picked in Settings: known ones only, in a stable order, at least one. */
export function cleanWindows(input: unknown): PostingWindow[] {
  const picked = Array.isArray(input) ? input.map(String) : [];
  const keys = WINDOW_KEYS.filter((k) => picked.includes(k));
  if (!keys.length) throw new UserError("Pick at least one time of day to post.");
  return keys;
}

/** The clock times to choose from for these windows (falls back to the default if none are valid). */
export function slotTimes(windows: readonly string[] = DEFAULT_WINDOWS): [number, number][] {
  const keys = windows.filter((w): w is PostingWindow => w in POSTING_WINDOWS);
  return (keys.length ? keys : DEFAULT_WINDOWS).flatMap((k) => POSTING_WINDOWS[k].times.map(([h, m]) => [h, m] as [number, number]));
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Next slot after the latest already-planned time (or now).
 * `seed` makes the choice stable for a given post, so re-rendering doesn't move it.
 */
export function nextSlot(taken: Date[], seed: string, tz: string, now: Date = new Date(), times = slotTimes()): Date {
  const h = hashString(seed);
  const future = taken.filter((d) => d.getTime() > now.getTime());
  const base = future.length ? new Date(Math.max(...future.map((d) => d.getTime()))) : now;
  const p = zonedParts(base, tz);
  // Work at noon to step whole days safely across DST changes.
  let day = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  day.setUTCDate(day.getUTCDate() + 2 + (h % 2));
  for (let i = 0; i < 7; i++) {
    const wd = day.getUTCDay();
    const okSaturday = wd === 6 && h % 4 === 0;      // the occasional Saturday post
    if (wd !== 0 && (wd !== 6 || okSaturday)) break;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const [hh, mm] = times[(h >>> 3) % times.length];
  let slot = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
  if (slot.getTime() <= now.getTime()) slot = new Date(now.getTime() + 2 * 3600 * 1000);
  return slot;
}

/** Plan several posts in a row. */
export function planSlots(count: number, taken: Date[], seeds: string[], tz: string, now = new Date(), times = slotTimes()): Date[] {
  const out: Date[] = [];
  const all = [...taken];
  for (let i = 0; i < count; i++) {
    const s = nextSlot(all, seeds[i] ?? String(i), tz, now, times);
    out.push(s);
    all.push(s);
  }
  return out;
}
