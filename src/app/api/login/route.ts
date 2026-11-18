import { NextResponse } from "next/server";
import { checkPassword, setSessionCookie } from "@/lib/auth";

// Simple in-memory throttle per server instance.
const attempts = new Map<string, { n: number; until: number }>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const a = attempts.get(ip);
  if (a && a.n >= 5 && a.until > Date.now()) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !checkPassword(password)) {
    attempts.set(ip, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60 * 1000 });
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }
  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res);
  return res;
}
