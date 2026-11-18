// Imports the posts planned in the Claude Post Desk artifact (seed/example.json) into an empty database.
//   npm run db:seed
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

type SeedPost = {
  key: string; status: string; account: string | null; topic: string; body: string; shareNote: string | null;
  scheduledFor: string | null; suggestedFor: string | null; postedAt: string | null; url: string | null;
  format: string | null; attachment: string | null; docTitle: string | null; sourceRefs: string[] | null;
};
type Seed = { voice: string; accounts: { id: string; kind: string; name: string; url: string }[]; posts: SeedPost[] };

const STATUS: Record<string, string> = { scheduled: "planned", draft: "draft", revise: "revise", posted: "posted", rejected: "rejected" };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  const seed = JSON.parse(readFileSync(join(process.cwd(), "seed", "example.json"), "utf8")) as Seed;

  let ws = (await c.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).rows[0];
  if (!ws) {
    ws = (await c.query("INSERT INTO workspaces (name, timezone, voice, github_repo) VALUES ($1,$2,$3,$4) RETURNING id",
      [process.env.WORKSPACE_NAME || "Acme Coffee Roasters", process.env.TIMEZONE || "America/New_York", seed.voice, process.env.GITHUB_REPO || null])).rows[0];
  }
  const existing = (await c.query("SELECT count(*)::int AS n FROM posts WHERE workspace_id = $1", [ws.id])).rows[0].n;
  if (existing > 0) { console.log(`Workspace already has ${existing} posts; skipping import.`); await c.end(); return; }
  await c.query("UPDATE workspaces SET voice = $2 WHERE id = $1 AND voice = ''", [ws.id, seed.voice]);

  // Accounts start in "post by hand" mode. Connecting them in Settings switches them to auto-posting.
  const accountIds: Record<string, string> = {};
  for (const a of seed.accounts) {
    const kind = a.id === "company" || /company/i.test(a.kind) ? "organization" : "person";
    const urn = `manual:${kind}:${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const row = (await c.query(
      `INSERT INTO accounts (workspace_id, kind, urn, name, profile_url, is_default, is_reshare_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id, urn) DO UPDATE SET profile_url = EXCLUDED.profile_url RETURNING id`,
      [ws.id, kind, urn, a.name, a.url || null, kind === "organization", kind === "person"])).rows[0];
    accountIds[a.id] = row.id;
  }
  const personId = Object.entries(accountIds).find(([k]) => k !== "company")?.[1] ?? null;

  for (const p of seed.posts) {
    let attachmentId: string | null = null;
    if (p.attachment && existsSync(join(process.cwd(), "seed", "attachments", p.attachment))) {
      const data = readFileSync(join(process.cwd(), "seed", "attachments", p.attachment));
      attachmentId = (await c.query(
        `INSERT INTO attachments (workspace_id, filename, content_type, size_bytes, data) VALUES ($1,$2,'application/pdf',$3,$4) RETURNING id`,
        [ws.id, p.attachment, data.length, data])).rows[0].id;
    }
    const status = STATUS[p.status] || "draft";
    await c.query(
      `INSERT INTO posts (workspace_id, account_id, reshare_account_id, status, topic, body, share_note, format, doc_title, attachment_id,
                          suggested_for, scheduled_for, posted_at, url, source, source_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'import',$15)`,
      [ws.id, accountIds[p.account || "company"] ?? null, accountIds[p.account || "company"] === personId ? null : personId, status,
       (p.topic || "").replace(/\s*\(carousel\)$/i, ""), p.body, p.shareNote, p.attachment ? "document" : "text", p.docTitle, attachmentId,
       p.suggestedFor, status === "planned" ? p.scheduledFor : null, p.postedAt, p.url, p.sourceRefs ?? []]);
  }
  console.log(`Imported ${seed.posts.length} posts and ${seed.accounts.length} accounts.`);
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
