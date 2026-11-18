import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { reviseDraft } from "@/lib/drafting";
import { adminRoute } from "@/lib/http";
import { getPost } from "@/lib/posts";
import { findTells } from "@/lib/tells";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

/** Rewrite a draft with Claude using its note, then put it back in review. */
export const POST = adminRoute<Ctx>(async (_req, { params }) => {
  const ws = await getWorkspace();
  const post = await getPost(params.id, ws.id);
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });
  const body = await reviseDraft(ws, post);
  const tells = findTells(body);
  await q(`UPDATE posts SET body = $2, status = 'draft', note = $3, updated_at = now() WHERE id = $1`,
    [post.id, body, tells.length ? `Flagged: ${tells.join(", ")}` : null]);
  return NextResponse.json({ ok: true });
});
