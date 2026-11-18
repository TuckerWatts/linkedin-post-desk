import { NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";
import { q } from "@/lib/db";
import { env } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { pageRoute } from "@/lib/http";
import { authorizeUrl } from "@/lib/linkedin";

/** /api/auth/linkedin/start?kind=person|organization. Opened as a page (Connect / Reconnect links). */
export const GET = pageRoute(async (req) => {
  if (!env.linkedin.configured) {
    console.error("LinkedIn connect: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are not set.");
    throw new UserError("Connecting LinkedIn isn't set up yet.");
  }
  const kind = new URL(req.url).searchParams.get("kind") === "organization" ? "organization" : "person";
  const state = randomToken();
  await q("DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'");
  await q("INSERT INTO oauth_states (state, kind) VALUES ($1, $2)", [state, kind]);
  return NextResponse.redirect(authorizeUrl(kind, state));
});
