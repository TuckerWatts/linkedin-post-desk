import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { adminRoute, readJson } from "@/lib/http";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

export const PATCH = adminRoute<Ctx>(async (req, { params }) => {
  const ws = await getWorkspace();
  const { replied } = await readJson<{ replied: boolean }>(req);
  const row = await one(
    `UPDATE comments c SET replied = $2 FROM posts p WHERE c.id = $1 AND p.id = c.post_id AND p.workspace_id = $3 RETURNING c.*`,
    [params.id, Boolean(replied), ws.id]);
  if (!row) return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  return NextResponse.json(row);
});
