import { NextResponse } from "next/server";
import { isLoggedIn, requireAdmin } from "./auth";
import { env } from "./env";
import { GENERIC_ERROR, UserError } from "./errors";

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/**
 * Wraps an admin-only route: checks the session and turns thrown errors into JSON. Only UserError messages reach the
 * browser; anything else is logged and answered with a plain generic message.
 */
export function adminRoute<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const denied = requireAdmin();
    if (denied) return denied;
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new Error("Expected a JSON body."); }
}

/** An absolute URL in this app, for redirects (APP_URL when set, otherwise the request's own origin). */
function appLink(req: Request, path: string): URL {
  let base: string;
  try { base = env.appUrl; } catch { base = new URL(req.url).origin; }
  return new URL(path, base + "/");
}

/** Back to the dashboard, showing `message` in its banner. */
export function backToDashboard(req: Request, message: string, ok = false): NextResponse {
  const u = appLink(req, "/");
  u.searchParams.set(ok ? "connected" : "error", message);
  return NextResponse.redirect(u);
}

/**
 * Wraps a route the browser opens as a page (PDF downloads, LinkedIn connect), so it never answers with JSON:
 * signed out goes to the sign-in page, and any problem goes back to the dashboard with a plain message in its banner.
 */
export function pageRoute<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    if (!isLoggedIn()) return NextResponse.redirect(appLink(req, "/login"));
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof UserError) return backToDashboard(req, e.message);
      console.error(e);
      return backToDashboard(req, GENERIC_ERROR);
    }
  };
}
