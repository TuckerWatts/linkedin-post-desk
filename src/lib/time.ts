// Small time-zone helpers built on Intl, so we don't need a date library.

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WD[p.weekday] };
}

/** Offset of tz from UTC at the given instant, in minutes. */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** The UTC instant for a wall-clock time in tz (DST-safe). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  ts = guess - tzOffsetMinutes(new Date(ts), tz) * 60000;
  return new Date(ts);
}

export function formatInZone(date: Date | string, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...opts })
    .format(new Date(date));
}

export type TimeZoneOption = { value: string; label: string };

/**
 * Time zones for a picker, grouped by region, labelled with the city in plain words and its current UTC offset:
 * "New York (GMT-5)". `current` is always included, even if this browser doesn't list it. Empty when the browser
 * can't list time zones (then a plain text field is the fallback).
 */
export function timeZoneOptions(current: string, now = new Date()): { region: string; options: TimeZoneOption[] }[] {
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  if (!list.length) return [];
  const zones = list.includes(current) || !current ? list : [current, ...list];
  const groups = new Map<string, TimeZoneOption[]>();
  for (const z of zones) {
    const parts = z.split("/");
    const region = parts.length > 1 ? parts[0] : "Other";
    const city = parts[parts.length - 1].replace(/_/g, " ");
    let offset = "";
    try {
      offset = new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "shortOffset" })
        .formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    } catch { continue; }
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region)!.push({ value: z, label: offset ? `${city} (${offset})` : city });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([region, options]) => ({ region, options: options.sort((a, b) => a.label.localeCompare(b.label)) }));
}
