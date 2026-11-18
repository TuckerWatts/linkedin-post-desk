// The dashboard's to-do list: things the scheduled jobs won't resolve on their own. Pure, so it runs in the browser.
import type { Account } from "./accounts";
import type { Post } from "./posts";

export type Todo = {
  kind: "post" | "reshare";
  post: Post;
  /** The account it was posting or resharing as (null if that account was removed). */
  account: Account | null;
  /** The date shown for the item, and its place in the list: when it was due to go out. */
  when: string;
  /** The account must be reconnected before a Retry can work. */
  reconnect: boolean;
};

/**
 * A connected account whose token no longer works: LinkedIn rejected it, it expired, or it was disconnected.
 * Accounts in "post by hand" mode never had a token, so they don't need reconnecting.
 */
export function needsReconnect(a: Account | null | undefined, now = Date.now()): boolean {
  if (!a || a.urn.startsWith("manual:")) return false;
  const expired = a.token_expires_at != null && Date.parse(a.token_expires_at) < now;
  return !a.connected || expired || a.reconnect_needed_at != null;
}

/**
 * Posts and reshares that failed, including ones flagged as possibly live, which need someone to check LinkedIn
 * before choosing Mark posted/shared or Retry. Ordered by the date each one was due, oldest first.
 */
export function todos(posts: Post[], accounts: Account[], now = Date.now()): Todo[] {
  const account = (id: string | null) => accounts.find((a) => a.id === id) ?? null;
  const out: Todo[] = [];
  for (const p of posts) {
    if (p.status === "failed") {
      const a = account(p.account_id);
      out.push({ kind: "post", post: p, account: a, when: p.scheduled_for ?? p.updated_at, reconnect: needsReconnect(a, now) });
    } else if (p.status === "posted" && p.reshare_status === "failed") {
      const a = account(p.reshare_account_id);
      out.push({ kind: "reshare", post: p, account: a, when: p.reshare_at ?? p.posted_at ?? p.updated_at, reconnect: needsReconnect(a, now) });
    }
  }
  return out.sort((x, y) => Date.parse(x.when) - Date.parse(y.when));
}
