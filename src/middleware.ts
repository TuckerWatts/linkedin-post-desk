import { NextResponse, type NextRequest } from "next/server";

// Edge-safe gate: pages without a session cookie go to /login.
// The cookie's signature is verified in every API route (requireAdmin), which run on Node.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathname.startsWith("/login") || pathname.startsWith("/api/") || pathname.startsWith("/_next") ||
    pathname.startsWith("/fonts") || pathname.startsWith("/logo-mark") || pathname === "/favicon.ico";
  if (open) return NextResponse.next();
  if (!req.cookies.get("pd_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
