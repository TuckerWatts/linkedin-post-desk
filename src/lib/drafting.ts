// Turns voice notes, recent posts and shipped work into LinkedIn drafts.
import { claude, extractJson } from "./anthropic";
import { mergedSince } from "./github";
import { createDraft, type Post, type Slide } from "./posts";
import { findTells } from "./tells";
import { q } from "./db";
import type { Workspace } from "./workspace";

const BASE_RULES = `You write LinkedIn posts for a company page and a one-line personal reshare note for its founder.
Hard rules:
- Sound like a real person who knows the audience's day. Specific moments and details, never generic advice-speak.
- No em dashes or en dashes. No buzzwords (delve, leverage, seamless, game-changer, unlock, elevate, journey, robust, transformative, synergy, "excited to announce", "in today's fast-paced world").
- Don't end every post with a question. Vary structure: short observation, story, list, opinion, tip.
- Vary length a lot: some 1-3 sentences, some 60-120 words, rarely more than 160.
- 0-2 hashtags, usually none. At most one emoji, usually none. No links.
- Inclusive language: families, parents, they. Never assume a parent's gender.
- Warm and positive. No fear, worst-case scenarios or guilt.
- Never invent statistics, customer quotes or events. Never mention AI.
- Company page voice is "we". The share note is the founder in first person, casual, under 15 words.`;

type DraftJson = {
  topic: string;
  body: string;
  shareNote?: string;
  carousel?: { docTitle: string; slides: Slide[] } | null;
  sourceRefs?: string[];
};

const OUTPUT_SPEC = `Reply with JSON only: an array of objects
{"topic": "2-5 word label", "body": "the post text", "shareNote": "founder's reshare line",
 "carousel": null | {"docTitle": "document title", "slides": [{"kind":"cover","title":"...","body":"..."}, {"kind":"point","title":"...","body":"...","quote":"optional","quoteLabel":"optional"}, ..., {"kind":"end","title":"question or takeaway","body":"..."}]},
 "sourceRefs": ["#123"] }
For a carousel, "body" is a short caption (1-3 sentences) and slides hold the content: 1 cover, 3-6 points, 1 end. Slide titles under 8 words, bodies under 30 words.`;

async function recentTopics(workspaceId: string): Promise<string> {
  const rows = await q<Pick<Post, "topic" | "body">>(
    `SELECT topic, left(body, 140) AS body FROM posts WHERE workspace_id=$1 AND status <> 'rejected' ORDER BY created_at DESC LIMIT 30`, [workspaceId]);
  return rows.map((r) => `- ${r.topic}: ${r.body.replace(/\s+/g, " ")}`).join("\n");
}

async function saveDrafts(ws: Workspace, drafts: DraftJson[], source: string): Promise<Post[]> {
  const out: Post[] = [];
  for (const d of drafts) {
    if (!d?.body || !d?.topic) continue;
    const isCarousel = Boolean(d.carousel?.slides?.length);
    const post = await createDraft(ws.id, ws.timezone, {
      topic: d.topic.slice(0, 80),
      body: d.body.trim(),
      shareNote: d.shareNote?.trim() || null,
      format: isCarousel ? "document" : "text",
      docTitle: isCarousel ? d.carousel!.docTitle : null,
      slides: isCarousel ? d.carousel!.slides : null,
      source,
      sourceRefs: d.sourceRefs ?? [],
    });
    const tells = findTells(post.body);
    if (tells.length) await q("UPDATE posts SET note = $2 WHERE id = $1", [post.id, `Flagged: ${tells.join(", ")}`]);
    out.push(post);
  }
  return out;
}

/** General drafts. `brief` is optional direction ("2 carousels about staffing"). */
export async function generateDrafts(ws: Workspace, count: number, brief = ""): Promise<Post[]> {
  const n = Math.max(1, Math.min(10, count));
  const user = `Company: ${ws.name}
Voice and audience notes from the founder:
${ws.voice || "(none yet)"}

Recent posts (don't repeat these topics or openings):
${await recentTopics(ws.id) || "(none)"}

${brief ? `Direction for this batch: ${brief}\n` : ""}Write ${n} new drafts. Make about one in four a carousel. ${OUTPUT_SPEC}`;
  const reply = await claude(BASE_RULES, user, 6000);
  return saveDrafts(ws, extractJson<DraftJson[]>(reply).slice(0, n), "generated");
}

/** Rewrite one draft using the note the founder left on it. */
export async function reviseDraft(ws: Workspace, post: Post): Promise<string> {
  const reply = await claude(BASE_RULES, `Voice notes:\n${ws.voice}\n\nRewrite this post following the feedback. Keep what works.
Feedback: ${post.note || "make it sound more human"}

Post:
${post.body}

Reply with JSON only: {"body": "..."}`, 2000);
  return extractJson<{ body: string }>(reply).body.trim();
}

/** One draft about the most director-relevant change merged in the last week. Returns null when nothing qualifies. */
export async function draftFromShipped(ws: Workspace): Promise<Post | null> {
  const repo = ws.github_repo;
  if (!repo) return null;
  const used = new Set((await q<{ ref: string }>(
    `SELECT unnest(source_refs) AS ref FROM posts WHERE workspace_id=$1`, [ws.id])).map((r) => r.ref));
  const shipped = (await mergedSince(repo, 7)).filter((s) => !used.has(s.ref));
  if (!shipped.length) return null;
  const list = shipped.map((s) => `${s.ref} ${s.title}${s.labels.length ? ` [${s.labels.join(", ")}]` : ""}\n${s.body.replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n");
  const reply = await claude(BASE_RULES, `Voice and audience notes:\n${ws.voice}

Changes merged this week:
${list}

Pick the ONE change a customer would notice and care about most. Skip refactors, dependency updates, infrastructure, tests, security fixes, unreleased or flagged work, and anything that names a customer.
If none qualifies, reply with exactly [].
Otherwise write one post that leads with the customer's moment, not the feature name, and says only what the change actually does.
${OUTPUT_SPEC} Include the PR refs you used in sourceRefs. Do not make it a carousel.`, 2000);
  const drafts = extractJson<DraftJson[]>(reply);
  if (!drafts.length) return null;
  const [post] = await saveDrafts(ws, drafts.slice(0, 1), "github");
  return post ?? null;
}
