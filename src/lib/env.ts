// Central place to read configuration. Throws with a clear message when a required value is missing.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const env = {
  get databaseUrl() { return required("DATABASE_URL"); },
  get appUrl() { return required("APP_URL").replace(/\/$/, ""); },
  get adminPassword() { return required("ADMIN_PASSWORD"); },
  get appSecret() {
    const s = required("APP_SECRET");
    if (Buffer.from(s, "base64").length < 32 && s.length < 32) {
      throw new Error("APP_SECRET must be at least 32 random bytes (base64).");
    }
    return s;
  },
  get cronSecret() { return required("CRON_SECRET"); },
  workspaceName: process.env.WORKSPACE_NAME || "My company",
  timezone: process.env.TIMEZONE || "America/New_York",
  linkedin: {
    get clientId() { return required("LINKEDIN_CLIENT_ID"); },
    get clientSecret() { return required("LINKEDIN_CLIENT_SECRET"); },
    version: process.env.LINKEDIN_VERSION || "202609",
    memberScopes: process.env.LINKEDIN_MEMBER_SCOPES || "openid profile w_member_social",
    orgScopes:
      process.env.LINKEDIN_ORG_SCOPES ||
      "openid profile w_member_social w_organization_social r_organization_social r_organization_social_feed rw_organization_admin",
    get configured() { return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET); },
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
  },
  github: {
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPO || "",
  },
};
