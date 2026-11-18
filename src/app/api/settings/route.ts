import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { adminRoute, readJson } from "@/lib/http";
import { getWorkspace } from "@/lib/workspace";

export const PUT = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ voice?: string; github_repo?: string | null; timezone?: string; name?: string }>(req);
  if (b.github_repo && !/^[\w.-]+\/[\w.-]+$/.test(b.github_repo)) throw new Error("Use owner/repo for the GitHub repo.");
  if (b.timezone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); } catch { throw new Error("Unknown time zone."); }
  }
  const row = await one(
    `UPDATE workspaces SET voice = COALESCE($2, voice), github_repo = CASE WHEN $3::text IS NULL THEN github_repo ELSE NULLIF($3, '') END,
       timezone = COALESCE($4, timezone), name = COALESCE($5, name) WHERE id = $1 RETURNING *`,
    [ws.id, b.voice ?? null, b.github_repo ?? null, b.timezone ?? null, b.name ?? null]);
  return NextResponse.json(row);
});
