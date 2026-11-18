import { NextResponse } from "next/server";
import { addManualAccount } from "@/lib/accounts";
import { UserError } from "@/lib/errors";
import { adminRoute, readJson } from "@/lib/http";
import { cleanDisplayName } from "@/lib/names";
import { getWorkspace } from "@/lib/workspace";

/** Add a page or profile you post to by hand (before LinkedIn approves API access). */
export const POST = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ kind: "person" | "organization"; name: string; profile_url?: string }>(req);
  const name = cleanDisplayName(b.name);
  if (!name) throw new UserError("Give the account a name.");
  if (!["person", "organization"].includes(b.kind)) throw new UserError("Pick profile or company page.");
  if (b.profile_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(b.profile_url)) throw new UserError("Use a linkedin.com link.");
  return NextResponse.json(await addManualAccount(ws.id, b.kind, name, b.profile_url || null));
});
