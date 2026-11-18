import { NextResponse } from "next/server";
import { draftFromShipped, generateDrafts } from "@/lib/drafting";
import { adminRoute, readJson } from "@/lib/http";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 60;

export const POST = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ count?: number; brief?: string; fromGithub?: boolean }>(req);
  if (b.fromGithub) {
    const post = await draftFromShipped(ws);
    return NextResponse.json({ created: post ? 1 : 0, message: post ? `Drafted "${post.topic}"` : "Nothing post-worthy merged this week." });
  }
  const posts = await generateDrafts(ws, b.count ?? 3, b.brief ?? "");
  return NextResponse.json({ created: posts.length });
});
