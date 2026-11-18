// Read-only GitHub access for "what we shipped this week" drafts.
import { env } from "./env";

export type Shipped = { ref: string; title: string; body: string; mergedAt: string; labels: string[] };

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(env.github.token ? { Authorization: `Bearer ${env.github.token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]} failed (${res.status}). Check GITHUB_TOKEN and GITHUB_REPO.`);
  return (await res.json()) as T;
}

/** Pull requests merged into the default branch in the last `days` days. */
export async function mergedSince(repo: string, days = 7): Promise<Shipped[]> {
  const since = Date.now() - days * 86400000;
  const prs = await gh<{ number: number; title: string; body: string | null; merged_at: string | null; labels: { name: string }[] }[]>(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
  );
  return prs
    .filter((p) => p.merged_at && new Date(p.merged_at).getTime() >= since)
    .map((p) => ({ ref: `#${p.number}`, title: p.title, body: (p.body || "").slice(0, 1500), mergedAt: p.merged_at!, labels: p.labels.map((l) => l.name) }));
}
