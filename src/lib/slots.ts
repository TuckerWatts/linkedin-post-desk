// Picks posting times that look human: 2-3 days apart, mostly weekdays, uneven minutes.
import { zonedParts, zonedTime } from "./time";

export const SLOT_TIMES: [number, number][] = [
  [6, 50], [7, 25], [7, 55], [8, 40], [11, 55], [12, 25], [13, 10], [16, 35], [19, 15],
];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Next slot after the latest already-planned time (or now).
 * `seed` makes the choice stable for a given post, so re-rendering doesn't move it.
 */
export function nextSlot(taken: Date[], seed: string, tz: string, now: Date = new Date()): Date {
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
  const [hh, mm] = SLOT_TIMES[(h >>> 3) % SLOT_TIMES.length];
  let slot = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
  if (slot.getTime() <= now.getTime()) slot = new Date(now.getTime() + 2 * 3600 * 1000);
  return slot;
}

/** Plan several posts in a row. */
export function planSlots(count: number, taken: Date[], seeds: string[], tz: string, now = new Date()): Date[] {
  const out: Date[] = [];
  const all = [...taken];
  for (let i = 0; i < count; i++) {
    const s = nextSlot(all, seeds[i] ?? String(i), tz, now);
    out.push(s);
    all.push(s);
  }
  return out;
}
