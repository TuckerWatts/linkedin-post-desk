import { NextResponse } from "next/server";
import { generateDrafts } from "@/lib/drafting";
import { adminRoute, readJson } from "@/lib/http";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 60;

export const POST = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ count?: number; brief?: string }>(req);
  const posts = await generateDrafts(ws, b.count ?? 3, b.brief ?? "");
  return NextResponse.json({ created: posts.length });
});
