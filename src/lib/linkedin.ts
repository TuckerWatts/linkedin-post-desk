// LinkedIn REST client: OAuth, Posts API, Documents API, comments.
// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
import { env } from "./env";

const API = "https://api.linkedin.com";
const OAUTH = "https://www.linkedin.com/oauth/v2";

export class LinkedInError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
  }
  /** Token expired or revoked: the account needs reconnecting. */
  get needsReconnect() { return this.status === 401; }
}

export type TokenSet = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

export function redirectUri(): string {
  return `${env.appUrl}/api/auth/linkedin/callback`;
}

export function authorizeUrl(kind: "person" | "organization", state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: env.linkedin.clientId,
    redirect_uri: redirectUri(),
    state,
    scope: kind === "organization" ? env.linkedin.orgScopes : env.linkedin.memberScopes,
  });
  return `${OAUTH}/authorization?${p}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${OAUTH}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: env.linkedin.clientId, client_secret: env.linkedin.clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) throw new LinkedInError(`LinkedIn token request failed (${res.status})`, res.status, text);
  return JSON.parse(text) as TokenSet;
}

export function exchangeCode(code: string) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
}

/** Only works for apps LinkedIn has granted refresh tokens (most Community Management API apps). */
export function refreshAccessToken(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": env.linkedin.version,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers as Record<string, string>) } });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new LinkedInError(`LinkedIn ${init.method || "GET"} ${path.split("?")[0]} failed (${res.status})`, res.status, body.slice(0, 2000));
  }
  return res;
}

export type UserInfo = { sub: string; name: string; picture?: string };

export async function getUserInfo(token: string): Promise<UserInfo> {
  const res = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new LinkedInError(`LinkedIn userinfo failed (${res.status})`, res.status, text);
  return JSON.parse(text) as UserInfo;
}

export type Org = { urn: string; name: string; vanityName?: string };

/** Pages where the connected member is an approved ADMINISTRATOR. */
export async function getAdminOrganizations(token: string): Promise<Org[]> {
  const res = await call(token, `/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50`);
  if (res.status === 404) return [];
  const data = (await res.json()) as { elements?: { organization: string }[] };
  const urns = Array.from(new Set((data.elements || []).map((e) => e.organization).filter(Boolean)));
  const orgs: Org[] = [];
  for (const urn of urns) {
    const id = urn.split(":").pop();
    try {
      const r = await call(token, `/rest/organizations/${id}`);
      const o = (await r.json()) as { localizedName?: string; vanityName?: string };
      orgs.push({ urn, name: o.localizedName || urn, vanityName: o.vanityName });
    } catch {
      orgs.push({ urn, name: urn });
    }
  }
  return orgs;
}

/**
 * Post "commentary" uses LinkedIn's Little Text Format, where these characters are reserved:
 *   \ | { } @ [ ] ( ) < > # * _ ~
 * Escape them all, then turn #words back into real hashtags.
 */
export function toLittleText(text: string): string {
  const escaped = text.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => `\\${c}`);
  return escaped.replace(/(^|\s)\\#([\p{L}\p{N}_]+)/gu, (_m, pre, tag) => `${pre}{hashtag|\\#|${tag}}`);
}

export type PostInput = {
  author: string;               // urn:li:person:... or urn:li:organization:...
  text: string;
  document?: { urn: string; title: string };
  reshareOf?: string;           // parent post URN
};

export function buildPostBody(p: PostInput) {
  const body: Record<string, unknown> = {
    author: p.author,
    commentary: toLittleText(p.text),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (p.document) body.content = { media: { title: p.document.title, id: p.document.urn } };
  if (p.reshareOf) body.reshareContext = { parent: p.reshareOf };
  return body;
}

/** Returns the new post's URN (from the x-restli-id header). */
export async function createPost(token: string, input: PostInput): Promise<string> {
  const res = await call(token, "/rest/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPostBody(input)),
  });
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id");
  if (!urn) throw new LinkedInError("LinkedIn created the post but returned no id", res.status, "");
  return urn;
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/** Upload a PDF/PPTX/DOCX (max 100 MB, 300 pages) and wait until LinkedIn has processed it. */
export async function uploadDocument(token: string, ownerUrn: string, bytes: Uint8Array): Promise<string> {
  const init = await call(token, "/rest/documents?action=initializeUpload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });
  const { value } = (await init.json()) as { value: { uploadUrl: string; document: string } };
  const put = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: Buffer.from(bytes),
  });
  if (!put.ok) throw new LinkedInError(`Document upload failed (${put.status})`, put.status, await put.text());

  for (let i = 0; i < 15; i++) {
    const r = await call(token, `/rest/documents/${encodeURIComponent(value.document)}`);
    if (r.status !== 404) {
      const d = (await r.json()) as { status?: string };
      if (d.status === "AVAILABLE") return value.document;
      if (d.status === "PROCESSING_FAILED") throw new LinkedInError("LinkedIn could not process the document", 422, JSON.stringify(d));
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  // Still processing: LinkedIn usually accepts the post anyway once processing finishes.
  return value.document;
}

export type LiComment = { id: string; actor?: string; text: string; time?: number };

/** Comments on a post. Org posts need r_organization_social_feed. Returns [] when there are none. */
export async function getComments(token: string, postUrn: string): Promise<LiComment[]> {
  const res = await call(token, `/rest/socialActions/${encodeURIComponent(postUrn)}/comments?count=100`);
  if (res.status === 404) return [];
  const data = (await res.json()) as {
    elements?: { id: string; actor?: string; message?: { text?: string }; created?: { time?: number } }[];
  };
  return (data.elements || []).map((e) => ({ id: e.id, actor: e.actor, text: e.message?.text || "", time: e.created?.time }));
}
