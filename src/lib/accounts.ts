import { decrypt, encrypt } from "./crypto";
import { one, q } from "./db";
import { env } from "./env";
import { refreshAccessToken, type TokenSet } from "./linkedin";

export type Account = {
  id: string;
  workspace_id: string;
  kind: "person" | "organization";
  urn: string;
  name: string;
  profile_url: string | null;
  token_expires_at: string | null;
  is_default: boolean;
  is_reshare_default: boolean;
  connected: boolean;
};

const PUBLIC_COLS = `id, workspace_id, kind, urn, name, profile_url, token_expires_at, is_default, is_reshare_default,
  (access_token_enc IS NOT NULL) AS connected`;

export function listAccounts(workspaceId: string) {
  return q<Account>(`SELECT ${PUBLIC_COLS} FROM accounts WHERE workspace_id = $1 ORDER BY kind DESC, name`, [workspaceId]);
}

export function getAccount(id: string) {
  return one<Account>(`SELECT ${PUBLIC_COLS} FROM accounts WHERE id = $1`, [id]);
}

export async function saveAccount(a: {
  workspaceId: string; kind: "person" | "organization"; urn: string; name: string; profileUrl?: string | null; tokens: TokenSet;
}) {
  const exp = new Date(Date.now() + a.tokens.expires_in * 1000).toISOString();
  const access = encrypt(a.tokens.access_token, env.appSecret);
  const refresh = a.tokens.refresh_token ? encrypt(a.tokens.refresh_token, env.appSecret) : null;
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM accounts WHERE workspace_id = $1 AND kind = $2", [a.workspaceId, a.kind]);
  const first = (count?.n ?? 0) === 0;
  return one<Account>(
    `INSERT INTO accounts (workspace_id, kind, urn, name, profile_url, access_token_enc, refresh_token_enc, token_expires_at, is_default, is_reshare_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id, urn) DO UPDATE SET
       name = EXCLUDED.name,
       profile_url = COALESCE(accounts.profile_url, EXCLUDED.profile_url),
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, accounts.refresh_token_enc),
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = now()
     RETURNING ${PUBLIC_COLS}`,
    [a.workspaceId, a.kind, a.urn, a.name, a.profileUrl ?? null, access, refresh, exp,
     first && a.kind === "organization", first && a.kind === "person"],
  );
}

/** Returns a usable access token, refreshing it when it is close to expiry and a refresh token exists. */
export async function accessTokenFor(accountId: string): Promise<string> {
  const row = await one<{ access_token_enc: string | null; refresh_token_enc: string | null; token_expires_at: string | null }>(
    "SELECT access_token_enc, refresh_token_enc, token_expires_at FROM accounts WHERE id = $1", [accountId]);
  if (!row?.access_token_enc) throw new Error("This LinkedIn account isn't connected. Connect it in Settings.");
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const soon = expiresAt - Date.now() < 3 * 24 * 3600 * 1000;
  if (soon && row.refresh_token_enc) {
    const t = await refreshAccessToken(decrypt(row.refresh_token_enc, env.appSecret));
    await q(
      `UPDATE accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), token_expires_at = $4, updated_at = now() WHERE id = $1`,
      [accountId, encrypt(t.access_token, env.appSecret), t.refresh_token ? encrypt(t.refresh_token, env.appSecret) : null,
       new Date(Date.now() + t.expires_in * 1000).toISOString()],
    );
    return t.access_token;
  }
  if (expiresAt && expiresAt < Date.now()) throw new Error("The LinkedIn connection expired. Reconnect it in Settings.");
  return decrypt(row.access_token_enc, env.appSecret);
}

/** Add an account that can't post via the API yet (manual mode: copy, open LinkedIn, paste). */
export function addManualAccount(workspaceId: string, kind: "person" | "organization", name: string, profileUrl: string | null) {
  const urn = `manual:${kind}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return one<Account>(
    `INSERT INTO accounts (workspace_id, kind, urn, name, profile_url, is_default, is_reshare_default)
     VALUES ($1,$2,$3,$4,$5, $2 = 'organization' AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id=$1 AND kind='organization'),
                             $2 = 'person' AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id=$1 AND kind='person'))
     ON CONFLICT (workspace_id, urn) DO UPDATE SET profile_url = EXCLUDED.profile_url
     RETURNING ${PUBLIC_COLS}`,
    [workspaceId, kind, urn, name, profileUrl],
  );
}
