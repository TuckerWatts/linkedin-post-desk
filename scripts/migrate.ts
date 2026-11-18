// Applies db/migrations/*.sql in order, once each.  npm run db:migrate
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const dir = join(process.cwd(), "db", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    await c.query("BEGIN");
    try {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log("applied", f);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
  await c.end();
  console.log("migrations up to date");
}

main().catch((e) => { console.error(e); process.exit(1); });
