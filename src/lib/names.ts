// Rules for the names shown for accounts and printed on carousels. Pure, so the dashboard can use them too.
import { UserError } from "./errors";

/** What the workspace is called when WORKSPACE_NAME isn't set. A placeholder, never a real company name. */
export const DEFAULT_WORKSPACE_NAME = "My company";

/** Looks like an identifier rather than a name people would recognise: a LinkedIn URN or a bare number. */
export function looksLikeId(name: string): boolean {
  const n = name.trim();
  return /urn:li:/i.test(n) || /^\d+$/.test(n);
}

/**
 * The name to print at the top of a carousel, or null to print none. Empty names, identifiers and the default
 * workspace placeholder are never printed: a carousel without a name is better than one headed "urn:li:…".
 */
export function publisherName(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    const n = c?.trim();
    if (n && !looksLikeId(n) && n !== DEFAULT_WORKSPACE_NAME) return n;
  }
  return null;
}

/**
 * Validates a name someone typed for an account. Returns null when it's blank, which means "use LinkedIn's name".
 */
export function cleanDisplayName(input: unknown): string | null {
  const n = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!n) return null;
  if (n.length > 100) throw new UserError("Keep the name under 100 characters.");
  if (looksLikeId(n)) throw new UserError("Use the name people know this account by.");
  return n;
}
