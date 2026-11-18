import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { q } from "@/lib/db";
import { env } from "@/lib/env";
import { authorizeUrl } from "@/lib/linkedin";

/** /api/auth/linkedin/start?kind=person|organization */
export async function GET(req: Request) {
  const denied = requireAdmin();
  if (denied) return denied;
  if (!env.linkedin.configured) return NextResponse.json({ error: "Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET first." }, { status: 400 });
  const kind = new URL(req.url).searchParams.get("kind") === "organization" ? "organization" : "person";
  const state = randomToken();
  await q("DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'");
  await q("INSERT INTO oauth_states (state, kind) VALUES ($1, $2)", [state, kind]);
  return NextResponse.redirect(authorizeUrl(kind, state));
}
