import { NextResponse } from "next/server";
import { listAccounts } from "@/lib/accounts";
import { hasCompanyLogo } from "@/lib/carousel";
import { q } from "@/lib/db";
import { env } from "@/lib/env";
import { adminRoute } from "@/lib/http";
import { forDashboard, listComments, listPosts } from "@/lib/posts";
import { getWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export const GET = adminRoute(async () => {
  const ws = await getWorkspace();
  const [accounts, posts, comments, jobs] = await Promise.all([
    listAccounts(ws.id),
    listPosts(ws.id),
    listComments(ws.id),
    // Only the plain note: the technical summary is for operators, not the dashboard.
    q(`SELECT DISTINCT ON (job) job, started_at, finished_at, ok, note FROM job_runs ORDER BY job, started_at DESC`),
  ]);
  return NextResponse.json({
    workspace: ws,
    accounts,
    posts: posts.map((p) => forDashboard(p, accounts)),
    comments,
    jobs,
    config: {
      linkedin: env.linkedin.configured,
      drafting: Boolean(env.anthropic.apiKey),
      companyLogo: hasCompanyLogo(),
    },
  });
});
