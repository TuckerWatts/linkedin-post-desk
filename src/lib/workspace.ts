import { one } from "./db";
import { env } from "./env";

export type Workspace = {
  id: string;
  name: string;
  timezone: string;
  voice: string;
  /** Times of day new drafts are suggested for: keys of POSTING_WINDOWS. */
  posting_windows: string[];
  /** Carousel color (#RRGGBB), or null for the neutral default. */
  carousel_color: string | null;
};

const COLS = "id, name, timezone, voice, posting_windows, carousel_color";

/** Single-workspace mode: the first workspace, created on first use. */
export async function getWorkspace(): Promise<Workspace> {
  const ws = await one<Workspace>(`SELECT ${COLS} FROM workspaces ORDER BY created_at LIMIT 1`);
  if (ws) return ws;
  const created = await one<Workspace>(
    `INSERT INTO workspaces (name, timezone) VALUES ($1, $2) RETURNING ${COLS}`,
    [env.workspaceName, env.timezone],
  );
  return created!;
}
