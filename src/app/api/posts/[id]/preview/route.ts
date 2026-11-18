import { NextResponse } from "next/server";
import { adminRoute, readJson } from "@/lib/http";
import { postCarouselPdf } from "@/lib/post-carousel";
import { getPost, type Slide } from "@/lib/posts";
import { cleanDeckTitle, cleanSlides } from "@/lib/slides";
import { getWorkspace } from "@/lib/workspace";

type Ctx = { params: { id: string } };

/** The carousel PDF for slides that haven't been saved yet, so the slide editor can preview them. Saves nothing. */
export const POST = adminRoute<Ctx>(async (req, { params }) => {
  const ws = await getWorkspace();
  const post = await getPost(params.id, ws.id);
  if (!post) return NextResponse.json({ error: "That post no longer exists." }, { status: 404 });
  const b = await readJson<{ slides?: Slide[]; docTitle?: string }>(req);
  const slides = cleanSlides(b.slides); // the same checks as saving, with the same plain messages
  const bytes = await postCarouselPdf(post, ws, slides, cleanDeckTitle(b.docTitle, post.topic));
  return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=\"preview.pdf\"" } });
});
