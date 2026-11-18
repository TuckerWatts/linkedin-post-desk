import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { adminRoute, pageRoute } from "@/lib/http";
import { postCarouselPdf } from "@/lib/post-carousel";
import { getPost } from "@/lib/posts";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

/** Download the post's PDF. Builds it from the slides if there isn't an uploaded one. Opened as a page (a link). */
export const GET = pageRoute<Ctx>(async (_req, { params }) => {
  const ws = await getWorkspace();
  const post = await getPost(params.id, ws.id);
  if (!post) throw new UserError("That post no longer exists.");
  let bytes: Uint8Array; let name: string;
  if (post.attachment_id) {
    const a = await one<{ data: Buffer; filename: string }>("SELECT data, filename FROM attachments WHERE id = $1", [post.attachment_id]);
    bytes = new Uint8Array(a!.data); name = a!.filename;
  } else if (post.slides?.length) {
    bytes = await postCarouselPdf(post, ws);
    name = `${(post.doc_title || post.topic).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;
  } else {
    throw new UserError("That post doesn't have a PDF yet.");
  }
  return new Response(Buffer.from(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"` },
  });
});

/** Upload your own PDF for a document post (multipart field "file"). */
export const POST = adminRoute<Ctx>(async (req, { params }) => {
  const ws = await getWorkspace();
  const post = await getPost(params.id, ws.id);
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new UserError("Choose a PDF to upload.");
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new UserError("Upload a PDF.");
  if (file.size > 100 * 1024 * 1024) throw new UserError("LinkedIn accepts documents up to 100 MB.");
  const buf = Buffer.from(await file.arrayBuffer());
  const att = await one<{ id: string }>(
    `INSERT INTO attachments (workspace_id, filename, content_type, size_bytes, data) VALUES ($1,$2,'application/pdf',$3,$4) RETURNING id`,
    [ws.id, file.name, buf.length, buf]);
  await q(`UPDATE posts SET attachment_id = $2, format = 'document', doc_title = COALESCE(doc_title, $3), updated_at = now() WHERE id = $1`,
    [post.id, att!.id, file.name.replace(/\.pdf$/i, "")]);
  return NextResponse.json({ ok: true });
});
