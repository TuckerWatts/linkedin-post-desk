import { saveAccount } from "@/lib/accounts";
import { one } from "@/lib/db";
import { backToDashboard, pageRoute } from "@/lib/http";
import { exchangeCode, getAdminOrganizations, getUserInfo } from "@/lib/linkedin";
import { getWorkspace } from "@/lib/workspace";

/** LinkedIn sends the browser back here after sign-in. Every outcome returns to the dashboard with a plain message. */
export const GET = pageRoute(async (req) => {
  const back = (msg: string, ok: boolean) => backToDashboard(req, msg, ok);
  const p = new URL(req.url).searchParams;
  if (p.get("error")) {
    // LinkedIn's own error text is technical; log it and show a plain sentence.
    const cancelled = /cancel/i.test(`${p.get("error")} ${p.get("error_description") ?? ""}`);
    if (!cancelled) console.error("LinkedIn sign-in error:", p.get("error"), p.get("error_description"));
    return back(cancelled ? "LinkedIn sign-in was cancelled." : "LinkedIn didn't let the app connect. Try again.", false);
  }
  const state = p.get("state") || "";
  const code = p.get("code") || "";
  const row = await one<{ kind: "person" | "organization" }>(
    "DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '1 hour' RETURNING kind", [state]);
  if (!row || !code) return back("That sign-in link expired. Try connecting again.", false);

  try {
    const ws = await getWorkspace();
    const tokens = await exchangeCode(code);
    const me = await getUserInfo(tokens.access_token);
    // saveAccount returns null when LinkedIn gave no name for an account we don't have yet: it's never named by its ID.
    const person = await saveAccount({ workspaceId: ws.id, kind: "person", urn: `urn:li:person:${me.sub}`, name: me.name ?? null, tokens });
    if (row.kind === "person") {
      return person ? back(person.name, true) : back("Couldn't read your name from LinkedIn. Try connecting again.", false);
    }

    const orgs = await getAdminOrganizations(tokens.access_token);
    if (!orgs.length) return back("Connected your profile, but found no company pages where you're an admin.", false);
    const connected: string[] = [];
    let unnamed = 0;
    for (const o of orgs) {
      const acct = await saveAccount({
        workspaceId: ws.id, kind: "organization", urn: o.urn, name: o.name,
        profileUrl: o.vanityName ? `https://www.linkedin.com/company/${o.vanityName}/` : null, tokens,
      });
      if (acct) connected.push(acct.name); else unnamed++;
    }
    if (unnamed) console.error(`LinkedIn connect: no name for ${unnamed} organization(s); not added.`);
    if (!connected.length) return back("Couldn't read your company page's name from LinkedIn. Try connecting again.", false);
    const missed = unnamed ? ` (LinkedIn didn't give the name of ${unnamed} other page${unnamed > 1 ? "s" : ""}, so ${unnamed > 1 ? "they weren't" : "it wasn't"} added. Try connecting again.)` : "";
    return back(connected.join(", ") + missed, true);
  } catch (e) {
    console.error("LinkedIn connect failed:", e);
    return back("Couldn't connect LinkedIn. Try again in a minute.", false);
  }
});
