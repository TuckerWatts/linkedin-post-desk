import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "./env";
import { safeEqual, sign, unsign } from "./crypto";

export const SESSION_COOKIE = "pd_session";
const MAX_AGE_S = 60 * 60 * 24 * 30;

export function checkPassword(pw: string): boolean {
  return safeEqual(pw, env.adminPassword);
}

export function sessionValue(): string {
  const exp = Date.now() + MAX_AGE_S * 1000;
  return sign(`admin:${exp}`, env.appSecret);
}

export function isValidSession(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = unsign(raw, env.appSecret);
  if (!v) return false;
  const exp = Number(v.split(":")[1]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function isLoggedIn(): boolean {
  return isValidSession(cookies().get(SESSION_COOKIE)?.value);
}

/** Use at the top of every API route that changes or reveals data. */
export function requireAdmin(): NextResponse | null {
  if (isLoggedIn()) return null;
  return NextResponse.json({ error: "Sign in first." }, { status: 401 });
}

export function setSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, sessionValue(), {
    httpOnly: true,
    secure: env.appUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

/** Scheduled jobs authenticate with "Authorization: Bearer CRON_SECRET" (Vercel Cron and the GitHub Action both send this). */
export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return token.length > 0 && safeEqual(token, secret);
}
