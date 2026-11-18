import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/http";
import { createDraft } from "@/lib/posts";
import { getWorkspace } from "@/lib/workspace";

export const POST = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ topic?: string; body?: string; shareNote?: string }>(req);
  if (!b.body?.trim()) throw new Error("Write something first.");
  const post = await createDraft(ws.id, ws.timezone, { topic: b.topic?.trim() || "Untitled", body: b.body.trim(), shareNote: b.shareNote });
  return NextResponse.json(post);
});
