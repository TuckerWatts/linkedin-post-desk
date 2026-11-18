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
  // The scheduler gets the technical log for its own output; the dashboard ("Run now") only gets the plain note.
  const cron = isCronRequest(req);
  const results: Record<string, { ok: boolean; note: string; summary?: string }> = {};
  for (const n of names) {
    const r = await runJob(n);
    results[n] = cron ? r : { ok: r.ok, note: r.note };
  }
  const ok = Object.values(results).every((r) => r.ok);
  return NextResponse.json(results, { status: ok ? 200 : 500 });
}

export const GET = handle;
export const POST = handle;
