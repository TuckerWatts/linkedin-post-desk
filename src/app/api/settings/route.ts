import { NextResponse } from "next/server";
import { isHexColor } from "@/lib/colors";
import { one } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { adminRoute, readJson } from "@/lib/http";
import { cleanWindows } from "@/lib/slots";
import { getWorkspace } from "@/lib/workspace";

export const PUT = adminRoute(async (req) => {
  const ws = await getWorkspace();
  const b = await readJson<{ voice?: string; timezone?: string; name?: string; posting_windows?: string[]; carousel_color?: string | null }>(req);
  if (b.carousel_color && !isHexColor(b.carousel_color)) throw new UserError("Pick a color with the color picker.");
  const windows = b.posting_windows === undefined ? null : cleanWindows(b.posting_windows);
  if (b.timezone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: b.timezone }); } catch { throw new UserError("Unknown time zone."); }
  }
  const row = await one(
    `UPDATE workspaces SET voice = COALESCE($2, voice), timezone = COALESCE($3, timezone), name = COALESCE($4, name),
       posting_windows = COALESCE($5, posting_windows),
       carousel_color = CASE WHEN $6 THEN $7 ELSE carousel_color END
     WHERE id = $1 RETURNING id, name, timezone, voice, posting_windows, carousel_color`,
    // carousel_color: absent leaves it alone; "" or null goes back to neutral.
    [ws.id, b.voice ?? null, b.timezone ?? null, b.name ?? null, windows, "carousel_color" in b, b.carousel_color || null]);
  return NextResponse.json(row);
});
