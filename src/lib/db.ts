import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

// One pool per server instance (reused across hot reloads in dev).
const g = globalThis as unknown as { __pdPool?: Pool };

export function pool(): Pool {
  if (!g.__pdPool) {
    const url = env.databaseUrl;
    const local = /localhost|127\.0\.0\.1/.test(url);
    g.__pdPool = new Pool({
      connectionString: url,
      max: 5,
      ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
    });
  }
  return g.__pdPool;
}

export async function q<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool().query<T>(text, params as unknown[]);
  return res.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
