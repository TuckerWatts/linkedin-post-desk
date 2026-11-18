import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationNumber, parseTo, planMigrations } from "../scripts/migration-plan";

const FILES = ["001_init.sql", "002_a.sql", "008_posting_windows.sql", "009_drop_github_columns.sql", "README.md"];

test("applies pending migrations in order, and --to holds back later ones", () => {
  assert.deepEqual(planMigrations(FILES, new Set(["001_init.sql"]), null),
    { apply: ["002_a.sql", "008_posting_windows.sql", "009_drop_github_columns.sql"], held: [] });
  assert.deepEqual(planMigrations(FILES, new Set(["001_init.sql"]), 8),
    { apply: ["002_a.sql", "008_posting_windows.sql"], held: ["009_drop_github_columns.sql"] });
  assert.deepEqual(planMigrations(FILES, new Set(FILES), null), { apply: [], held: [] });
});

test("--to accepts 8 or 008, and rejects anything else", () => {
  assert.equal(parseTo(["--to=008"]), 8);
  assert.equal(parseTo(["--to=8"]), 8);
  assert.equal(parseTo([]), null);
  assert.throws(() => parseTo(["--to=latest"]), /--to=NNN/);
});

test("the real migration files are numbered uniquely and in sequence", () => {
  const files = readdirSync(join(__dirname, "..", "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const numbers = files.map(migrationNumber);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), files.join(", "));
});

test("migrations that remove things come last, and the README's upgrade stops right before them", () => {
  const dir = join(__dirname, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const removes = (f: string) => /\bDROP\s+(COLUMN|TABLE|CONSTRAINT\s+(?!posts_reshare_status_check))/i.test(readFileSync(join(dir, f), "utf8"));
  const firstRemoval = files.findIndex(removes);
  if (firstRemoval < 0) return;
  // After the first removal, only removals: otherwise the new version would need a migration the upgrade holds back.
  assert.deepEqual(files.slice(firstRemoval).filter((f) => !removes(f)), [], "an adding migration comes after a removing one");
  const to = migrationNumber(files[firstRemoval]) - 1;
  const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
  assert.ok(readme.includes(`npm run db:migrate -- --to=${String(to).padStart(3, "0")}`), `README should say --to=${String(to).padStart(3, "0")}`);
});
