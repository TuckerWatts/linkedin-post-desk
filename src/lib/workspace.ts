import { one } from "./db";
import { env } from "./env";

export type Workspace = {
  id: string;
  name: string;
  timezone: string;
  voice: string;
  github_repo: string | null;
};

/** Single-workspace mode: the first workspace, created on first use. */
export async function getWorkspace(): Promise<Workspace> {
  const ws = await one<Workspace>("SELECT id, name, timezone, voice, github_repo FROM workspaces ORDER BY created_at LIMIT 1");
  if (ws) return ws;
  const created = await one<Workspace>(
    "INSERT INTO workspaces (name, timezone, github_repo) VALUES ($1, $2, $3) RETURNING id, name, timezone, voice, github_repo",
    [env.workspaceName, env.timezone, env.github.repo || null],
  );
  return created!;
}
