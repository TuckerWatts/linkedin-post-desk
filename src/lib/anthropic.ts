// Minimal Claude Messages API client (no SDK dependency).
import { env } from "./env";
import { UserError } from "./errors";

export async function claude(system: string, user: string, maxTokens = 4000): Promise<string> {
  if (!env.anthropic.apiKey) throw new UserError("Drafting isn't set up yet.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.anthropic.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { content: { type: string; text?: string }[] };
  return data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

/** Pulls the first JSON value out of a model reply (tolerates code fences and stray prose). */
export function extractJson<T>(reply: string): T {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : reply;
  const start = src.search(/[\[{]/);
  if (start < 0) throw new Error("The model reply had no JSON.");
  const open = src[start], close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(src.slice(start, i + 1)) as T;
  }
  throw new Error("The model reply had incomplete JSON.");
}
