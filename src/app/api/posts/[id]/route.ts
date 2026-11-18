import { NextResponse } from "next/server";
import { listAccounts } from "@/lib/accounts";
import { adminRoute, readJson } from "@/lib/http";
import { applyAction, forDashboard, type PostAction } from "@/lib/posts";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

export const PATCH = adminRoute<Ctx>(async (req, { params }) => {
  const ws = await getWorkspace();
  const action = await readJson<PostAction>(req);
  const post = await applyAction(params.id, ws.id, action);
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });
  return NextResponse.json(forDashboard(post, await listAccounts(ws.id)));
});
