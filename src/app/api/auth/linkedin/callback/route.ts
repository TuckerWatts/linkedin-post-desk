import { NextResponse } from "next/server";
import { saveAccount } from "@/lib/accounts";
import { requireAdmin } from "@/lib/auth";
import { one } from "@/lib/db";
import { env } from "@/lib/env";
import { exchangeCode, getAdminOrganizations, getUserInfo } from "@/lib/linkedin";
import { getWorkspace } from "@/lib/workspace";

function back(msg: string, ok: boolean) {
  const u = new URL(env.appUrl + "/");
  u.searchParams.set(ok ? "connected" : "error", msg);
  return NextResponse.redirect(u);
}

export async function GET(req: Request) {
  const denied = requireAdmin();
  if (denied) return denied;
  const p = new URL(req.url).searchParams;
  if (p.get("error")) return back(p.get("error_description") || "LinkedIn sign-in was cancelled.", false);
  const state = p.get("state") || "";
  const code = p.get("code") || "";
  const row = await one<{ kind: "person" | "organization" }>(
    "DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '1 hour' RETURNING kind", [state]);
  if (!row || !code) return back("That sign-in link expired. Try connecting again.", false);

  try {
    const ws = await getWorkspace();
    const tokens = await exchangeCode(code);
    const me = await getUserInfo(tokens.access_token);
    await saveAccount({ workspaceId: ws.id, kind: "person", urn: `urn:li:person:${me.sub}`, name: me.name, tokens });
    if (row.kind === "person") return back(me.name, true);

    const orgs = await getAdminOrganizations(tokens.access_token);
    if (!orgs.length) return back("Connected your profile, but found no company pages where you're an admin.", false);
    for (const o of orgs) {
      await saveAccount({
        workspaceId: ws.id, kind: "organization", urn: o.urn, name: o.name,
        profileUrl: o.vanityName ? `https://www.linkedin.com/company/${o.vanityName}/` : null, tokens,
      });
    }
    return back(orgs.map((o) => o.name).join(", "), true);
  } catch (e) {
    return back(e instanceof Error ? e.message : "Couldn't connect LinkedIn.", false);
  }
}
