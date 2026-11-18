import { NextResponse } from "next/server";
import { requireAdmin } from "./auth";

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps an admin-only route: checks the session and turns thrown errors into readable JSON. */
export function adminRoute<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const denied = requireAdmin();
    if (denied) return denied;
    try {
      return await fn(req, ctx);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong.";
      console.error(e);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new Error("Expected a JSON body."); }
}
