// Flags wording that makes a LinkedIn post read as machine-written.

export const AI_TELL_PHRASES = [
  "delve", "tapestry", "testament to", "leverage", "game-changer", "game changer", "unlock", "elevate", "landscape",
  "journey", "robust", "seamless", "crucial", "pivotal", "foster", "realm", "embark", "harness", "in today's",
  "fast-paced", "ever-evolving", "let that sink in", "here's the thing", "the truth is", "buckle up", "it's not just",
  "thrilled to", "excited to announce", "humbled", "furthermore", "moreover", "in conclusion", "at the end of the day",
  "transformative", "synergy", "cutting-edge", "deep dive", "unpack", "resonate", "empower", "key takeaways",
  "agree?", "thoughts?", "navigate the", "navigating the", "in a world where",
];

export function findTells(text: string): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  if (/—|–| -- /.test(text)) out.push("em dashes");
  for (const p of AI_TELL_PHRASES) {
    const re = new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`);
    if (re.test(t)) out.push(`"${p}"`);
  }
  if ((text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length > 2) out.push("more than 2 hashtags");
  if ((text.match(/\p{Extended_Pictographic}/gu) || []).length > 1) out.push("more than 1 emoji");
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 8 && lines.filter((l) => l.length < 70).length / lines.length > 0.7) out.push("too many one-line paragraphs");
  if (/https?:\/\//.test(text)) out.push("link in the post (cuts reach)");
  return out;
}
