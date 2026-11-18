// Which migrations `npm run db:migrate` applies. Kept apart from the script so it can be tested without a database.

/** The number a migration file starts with: "008_posting_windows.sql" → 8. */
export function migrationNumber(file: string): number {
  const n = parseInt(file, 10);
  if (Number.isNaN(n)) throw new Error(`Migration files start with a number: ${file}`);
  return n;
}

/** Reads "--to=8" or "--to=008" from the command line: apply nothing numbered higher. */
export function parseTo(args: string[]): number | null {
  const arg = args.find((a) => a.startsWith("--to="));
  if (!arg) return null;
  const n = parseInt(arg.slice("--to=".length), 10);
  if (Number.isNaN(n)) throw new Error(`Use --to=NNN, e.g. --to=008 (got ${arg})`);
  return n;
}

/** Pending migrations in order, and any held back by `to`. */
export function planMigrations(files: string[], applied: Set<string>, to: number | null): { apply: string[]; held: string[] } {
  const pending = files.filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();
  return {
    apply: pending.filter((f) => to === null || migrationNumber(f) <= to),
    held: pending.filter((f) => to !== null && migrationNumber(f) > to),
  };
}
