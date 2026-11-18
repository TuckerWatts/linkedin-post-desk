import { decrypt, encrypt } from "./crypto";
import { one, q } from "./db";
import { env } from "./env";
import { LinkedInError, refreshAccessToken, type TokenSet } from "./linkedin";
import { looksLikeId } from "./names";

export type Account = {
  id: string;
  workspace_id: string;
  kind: "person" | "organization";
  urn: string;
  /** The name shown everywhere: the one chosen in Settings, else LinkedIn's; never an ID (see withShownName). */
  name: string;
  /** The name LinkedIn gave (or the one typed when a post-by-hand account was added). */
  linkedin_name: string;
  /** The name chosen in Settings, if any. */
  display_name: string | null;
  /** No usable name: saved by ID before names were checked, and not renamed yet. */
  name_missing: boolean;
  profile_url: string | null;
  token_expires_at: string | null;
  is_default: boolean;
  is_reshare_default: boolean;
  connected: boolean;
  /** When LinkedIn last rejected this account's token; null once reconnected. */
  reconnect_needed_at: string | null;
};

const PUBLIC_COLS = `id, workspace_id, kind, urn, name AS linkedin_name, display_name,
  profile_url, token_expires_at, is_default, is_reshare_default, (access_token_enc IS NOT NULL) AS connected, reconnect_needed_at`;

type AccountRow = Omit<Account, "name" | "name_missing">;

/** Works out the name to show: a chosen name, else LinkedIn's, and a plain placeholder instead of an ID. */
export function withShownName(r: AccountRow): Account;
export function withShownName(r: AccountRow | null): Account | null;
export function withShownName(r: AccountRow | null): Account | null {
  if (!r) return null;
  const missing = !r.display_name && looksLikeId(r.linkedin_name);
  const placeholder = r.kind === "organization" ? "Unnamed page" : "Unnamed profile";
  return { ...r, name: r.display_name || (missing ? placeholder : r.linkedin_name), name_missing: missing };
}

export async function listAccounts(workspaceId: string): Promise<Account[]> {
  const rows = await q<AccountRow>(`SELECT ${PUBLIC_COLS} FROM accounts WHERE workspace_id = $1 ORDER BY kind DESC, COALESCE(display_name, name)`, [workspaceId]);
  return rows.map((r) => withShownName(r));
}

export async function getAccount(id: string): Promise<Account | null> {
  return withShownName(await one<AccountRow>(`SELECT ${PUBLIC_COLS} FROM accounts WHERE id = $1`, [id]));
}

/**
 * Stores a connected account's tokens. `name` is LinkedIn's name for it, or null when LinkedIn didn't give one: then
 * an existing account keeps the name it has, and a new account isn't created (returns null), because an account
 * must never be named by its ID.
 */
export async function saveAccount(a: {
  workspaceId: string; kind: "person" | "organization"; urn: string; name: string | null; profileUrl?: string | null; tokens: TokenSet;
}): Promise<Account | null> {
  const exp = new Date(Date.now() + a.tokens.expires_in * 1000).toISOString();
  const access = encrypt(a.tokens.access_token, env.appSecret);
  const refresh = a.tokens.refresh_token ? encrypt(a.tokens.refresh_token, env.appSecret) : null;
  const name = a.name?.trim() && !looksLikeId(a.name) ? a.name.trim() : null;
  if (!name) {
    return withShownName(await one<AccountRow>(
      `UPDATE accounts SET access_token_enc = $3, refresh_token_enc = COALESCE($4, refresh_token_enc), token_expires_at = $5,
         profile_url = COALESCE(profile_url, $6), reconnect_needed_at = NULL, updated_at = now()
       WHERE workspace_id = $1 AND urn = $2 RETURNING ${PUBLIC_COLS}`,
      [a.workspaceId, a.urn, access, refresh, exp, a.profileUrl ?? null]));
  }
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM accounts WHERE workspace_id = $1 AND kind = $2", [a.workspaceId, a.kind]);
  const first = (count?.n ?? 0) === 0;
  return withShownName(await one<AccountRow>(
    `INSERT INTO accounts (workspace_id, kind, urn, name, profile_url, access_token_enc, refresh_token_enc, token_expires_at, is_default, is_reshare_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id, urn) DO UPDATE SET
       name = EXCLUDED.name,
       profile_url = COALESCE(accounts.profile_url, EXCLUDED.profile_url),
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, accounts.refresh_token_enc),
       token_expires_at = EXCLUDED.token_expires_at,
       reconnect_needed_at = NULL,
       updated_at = now()
     RETURNING ${PUBLIC_COLS}`,
    [a.workspaceId, a.kind, a.urn, name, a.profileUrl ?? null, access, refresh, exp,
     first && a.kind === "organization", first && a.kind === "person"],
  ));
}

/** The account has no working LinkedIn connection: it was never connected, it expired, or LinkedIn won't renew it. */
export class NotConnectedError extends Error {}

/** Returns a usable access token, refreshing it when it is close to expiry and a refresh token exists. */
export async function accessTokenFor(accountId: string): Promise<string> {
  const row = await one<{ access_token_enc: string | null; refresh_token_enc: string | null; token_expires_at: string | null }>(
    "SELECT access_token_enc, refresh_token_enc, token_expires_at FROM accounts WHERE id = $1", [accountId]);
  if (!row?.access_token_enc) throw new NotConnectedError("This LinkedIn account isn't connected. Connect it in Settings.");
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const soon = expiresAt - Date.now() < 3 * 24 * 3600 * 1000;
  if (soon && row.refresh_token_enc) {
    let t: TokenSet;
    try {
      t = await refreshAccessToken(decrypt(row.refresh_token_enc, env.appSecret));
    } catch (e) {
      // 400/401 from the token endpoint: the refresh token was revoked or has expired.
      if (e instanceof LinkedInError && (e.status === 400 || e.status === 401)) {
        throw new NotConnectedError(`LinkedIn wouldn't renew the connection (${e.message}). Reconnect it in Settings.`);
      }
      throw e;
    }
    await q(
      `UPDATE accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), token_expires_at = $4,
         reconnect_needed_at = NULL, updated_at = now() WHERE id = $1`,
      [accountId, encrypt(t.access_token, env.appSecret), t.refresh_token ? encrypt(t.refresh_token, env.appSecret) : null,
       new Date(Date.now() + t.expires_in * 1000).toISOString()],
    );
    return t.access_token;
  }
  if (expiresAt && expiresAt < Date.now()) throw new NotConnectedError("The LinkedIn connection expired. Reconnect it in Settings.");
  return decrypt(row.access_token_enc, env.appSecret);
}

/** LinkedIn rejected this account's token (401): it needs reconnecting before anything posts as it again. */
export async function flagReconnect(accountId: string): Promise<void> {
  await q("UPDATE accounts SET reconnect_needed_at = now() WHERE id = $1", [accountId]);
}

/** Add an account that can't post via the API yet (manual mode: copy, open LinkedIn, paste). */
export async function addManualAccount(workspaceId: string, kind: "person" | "organization", name: string, profileUrl: string | null) {
  const urn = `manual:${kind}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return withShownName(await one<AccountRow>(
    `INSERT INTO accounts (workspace_id, kind, urn, name, profile_url, is_default, is_reshare_default)
     VALUES ($1,$2,$3,$4,$5, $2 = 'organization' AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id=$1 AND kind='organization'),
                             $2 = 'person' AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id=$1 AND kind='person'))
     ON CONFLICT (workspace_id, urn) DO UPDATE SET profile_url = EXCLUDED.profile_url
     RETURNING ${PUBLIC_COLS}`,
    [workspaceId, kind, urn, name, profileUrl],
  ));
}
