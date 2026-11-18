// Builds a post's carousel PDF exactly as it will be published: its account's name, the workspace's color.
import { getAccount } from "./accounts";
import { buildCarouselPdf } from "./carousel";
import { publisherName } from "./names";
import type { Post, Slide } from "./posts";
import type { Workspace } from "./workspace";

/** `slides` and `deckTitle` default to what's saved; the slide editor passes unsaved ones to preview them. */
export async function postCarouselPdf(post: Post, ws: Workspace, slides: Slide[] = post.slides ?? [], deckTitle?: string): Promise<Uint8Array> {
  const account = post.account_id ? await getAccount(post.account_id) : null;
  return buildCarouselPdf(slides, {
    name: publisherName(account?.name, ws.name),
    label: deckTitle || post.doc_title || post.topic,
    color: ws.carousel_color,
  });
}
