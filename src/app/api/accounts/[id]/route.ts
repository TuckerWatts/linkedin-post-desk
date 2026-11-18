import { NextResponse } from "next/server";
import { getAccount } from "@/lib/accounts";
import { q, tx } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { adminRoute, readJson } from "@/lib/http";
import { cleanDisplayName } from "@/lib/names";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

export const PATCH = adminRoute<Ctx>(async (req, { params }) => {
  const ws = await getWorkspace();
  const acct = await getAccount(params.id);
  if (!acct || acct.workspace_id !== ws.id) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const b = await readJson<{ makeDefault?: boolean; makeReshareDefault?: boolean; profile_url?: string | null; display_name?: string | null }>(req);
  const displayName = "display_name" in b ? cleanDisplayName(b.display_name) : undefined; // blank: back to LinkedIn's name
  if (b.profile_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(b.profile_url)) throw new UserError("Use a linkedin.com link.");
  await tx(async (c) => {
    if (b.makeDefault) {
      await c.query("UPDATE accounts SET is_default = false WHERE workspace_id = $1", [ws.id]);
      await c.query("UPDATE accounts SET is_default = true WHERE id = $1", [acct.id]);
    }
    if (b.makeReshareDefault) {
      await c.query("UPDATE accounts SET is_reshare_default = false WHERE workspace_id = $1", [ws.id]);
      await c.query("UPDATE accounts SET is_reshare_default = true WHERE id = $1", [acct.id]);
    }
    if (b.profile_url !== undefined) await c.query("UPDATE accounts SET profile_url = $2 WHERE id = $1", [acct.id, b.profile_url || null]);
    if (displayName !== undefined) await c.query("UPDATE accounts SET display_name = $2, updated_at = now() WHERE id = $1", [acct.id, displayName]);
  });
  return NextResponse.json(await getAccount(acct.id));
});

/** Disconnect: forget the tokens but keep the account so past posts still show who posted them. */
export const DELETE = adminRoute<Ctx>(async (_req, { params }) => {
  const ws = await getWorkspace();
  await q(`UPDATE accounts SET access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL WHERE id = $1 AND workspace_id = $2`,
    [params.id, ws.id]);
  return NextResponse.json({ ok: true });
});
