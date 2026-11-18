// Plain-language explanations of why a post or reshare didn't go out, and of each job's last run. Pure.
// The jobs store a kind (what sort of problem) next to the technical message; this turns the kind into a sentence.
// The technical message stays in the database and server logs for whoever operates the app; people never see it.
import type { Account } from "./accounts";
import type { Post } from "./posts";

export type ErrorKind =
  | "maybe_live"   // the request may have reached LinkedIn: check before retrying, or it could post twice
  | "interrupted"  // the run stopped before anything was sent
  | "reconnect"    // LinkedIn rejected the account's token, or the account isn't connected
  | "forbidden"    // LinkedIn says the account may not post there (403)
  | "rejected"     // LinkedIn refused the content (other 4xx)
  | "unavailable"  // LinkedIn errored or rate-limited (5xx, 429)
  | "unreachable"  // the app couldn't reach LinkedIn (network)
  | "plain"        // the message was written for people (UserError) and is shown as it is
  | "other";       // anything else, before anything was sent; the message is technical and never shown

/**
 * Why this post (or its reshare) didn't go out, as a plain sentence, or null when there's nothing to explain.
 * Never returns the technical message itself, except for "plain" ones, which were written to be shown.
 */
export function explain(what: "post" | "reshare", p: Post, account: Account | null): string | null {
  const raw = what === "post" ? p.error : p.reshare_error;
  if (!raw) return null;
  const kind = what === "post" ? p.error_kind : p.reshare_error_kind;
  // Posts retry on their own while 'planned'; a failed post, and any failed reshare, waits for a person.
  const retrying = what === "post" && p.status === "planned";
  const noun = what === "post" ? "post" : "reshare";
  const whose = account ? `${account.name}'s` : "the account's";
  const where = what === "post" ? "the page" : `${account ? `${account.name}'s` : "the"} profile`;
  const mark = what === "post" ? "Mark posted" : "Mark shared";
  const again = retrying ? "It will retry automatically." : "Press Retry to try again.";

  switch (kind) {
    case "maybe_live":
      return `This ${noun} may already be on LinkedIn, but the app couldn't confirm it. ` +
        `Check ${where}: if it's there, use ${mark}; if not, press Retry.`;
    case "interrupted":
      return retrying ? "The last attempt was interrupted before anything was sent. It will retry automatically."
        : what === "post" && p.attempts > 1
          ? `Publishing was interrupted ${p.attempts} times before anything was sent. Press Retry to try again.`
          : `The ${noun} was interrupted before anything was sent. Press Retry to try again.`;
    case "reconnect":
      return `LinkedIn rejected ${whose} connection. Reconnect it, then retry.`;
    case "forbidden":
      return `LinkedIn refused: ${account?.name ?? "this account"} doesn't have permission to ${what === "post" ? "post there" : "reshare this"}.`;
    case "rejected":
      return what === "post" ? "LinkedIn rejected the post. Check its text and any attachment, then press Retry."
        : "LinkedIn rejected the reshare. Press Retry to try again, or reshare it by hand.";
    case "unavailable":
      return `LinkedIn was unavailable. ${again}`;
    case "unreachable":
      return `The app couldn't reach LinkedIn. ${again}`;
    case "plain":
      return raw;
    case "other":
      return `Something went wrong before this ${noun} was sent. ${again}`;
    default:
      // Recorded before kinds existed: we can't tell whether it went out, so ask for a check first.
      return retrying ? "The last attempt didn't work. It will retry automatically."
        : `This ${noun} didn't go out as planned. Check ${where}: if it's there, use ${mark}; if not, press Retry.`;
  }
}

export type JobRun = { job: string; started_at: string; finished_at: string | null; ok: boolean | null; note: string | null };

/** A job's last run in plain words for Settings → Automation. `bad` when it needs noticing. */
export function jobStatus(run: JobRun | undefined, now = Date.now()): { text: string; bad: boolean } {
  if (!run) return { text: "Hasn't run yet.", bad: false };
  if (run.ok === null) {
    // Still running, or the process died before it could record the result.
    return now - Date.parse(run.started_at) < 15 * 60 * 1000
      ? { text: "Running now…", bad: false }
      : { text: "Last time it didn't finish. It'll try again automatically.", bad: true };
  }
  if (run.ok === false) return { text: run.note ?? "Didn't finish. It'll try again automatically.", bad: true };
  return { text: run.note ?? "Finished.", bad: false };
}

/** Notes that only say nothing happened; dropped when a check also did something. */
const IDLE_NOTES = new Set(["Nothing was due.", "Nothing to reshare."]);

const ATTENTION = /^(\d+) needs? your attention in To do\.$/;

/**
 * Combines the notes of the publish and reshare checks into one line, e.g. for the "Check now" message. Both can
 * report items needing attention, so those are added up ("2 … " and "2 … " become "4 need your attention in To do.").
 */
export function combineNotes(notes: (string | null | undefined)[]): string {
  const sentences = notes.filter((n): n is string => Boolean(n) && !IDLE_NOTES.has(n!))
    .flatMap((n) => n.split(/(?<=\.)\s+/));
  let attention = 0;
  const rest: string[] = [];
  for (const sentence of sentences) {
    const m = ATTENTION.exec(sentence);
    if (m) attention += Number(m[1]);
    else if (!rest.includes(sentence)) rest.push(sentence);
  }
  if (attention) rest.push(`${attention} need${attention === 1 ? "s" : ""} your attention in To do.`);
  return rest.length ? rest.join(" ") : "Nothing was due.";
}

/**
 * The one line Settings shows about automatic posting: when it last checked for due posts and reshares, and what
 * happened. Publishing and resharing run together, so they're reported together; a problem with either comes first.
 */
export function postingStatus(jobs: JobRun[], now = Date.now()): { text: string; bad: boolean; at: string | null } {
  const runs = jobs.filter((j) => j.job === "publish" || j.job === "reshare");
  if (!runs.length) return { text: "Hasn't checked yet.", bad: false, at: null };
  const at = runs.map((r) => r.started_at).sort().at(-1)!;
  const problem = runs.map((r) => jobStatus(r, now)).find((s) => s.bad);
  if (problem) return { ...problem, at };
  if (runs.some((r) => r.ok === null)) return { text: "Checking now…", bad: false, at };
  return { text: combineNotes(runs.map((r) => r.note)), bad: false, at };
}
