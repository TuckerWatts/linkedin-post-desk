import { NextResponse } from "next/server";
import { isCronRequest, requireAdmin } from "@/lib/auth";
import { JOBS, runJob, type JobName } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: { job: string } };

async function handle(req: Request, { params }: Ctx) {
  // Scheduler (Bearer CRON_SECRET) or a signed-in admin pressing "Run now".
  if (!isCronRequest(req) && requireAdmin()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const names: JobName[] = params.job === "all" ? ["publish", "reshare"] : [params.job as JobName];
  if (!names.every((n) => JOBS.includes(n))) return NextResponse.json({ error: `Unknown job. Use one of: all, ${JOBS.join(", ")}` }, { status: 404 });
  const results: Record<string, { ok: boolean; summary: string }> = {};
  for (const n of names) results[n] = await runJob(n);
  const ok = Object.values(results).every((r) => r.ok);
  return NextResponse.json(results, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
