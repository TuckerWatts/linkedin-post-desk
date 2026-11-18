"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Account } from "@/lib/accounts";
import type { Comment, Post, PostAction } from "@/lib/posts";
import { findTells } from "@/lib/tells";

type State = {
  workspace: { id: string; name: string; timezone: string; voice: string; github_repo: string | null };
  accounts: Account[];
  posts: Post[];
  comments: Comment[];
  jobs: { job: string; started_at: string; ok: boolean | null; summary: string | null }[];
  config: { linkedin: boolean; drafting: boolean; github: boolean };
};

const LINKEDIN_COMPOSE = "https://www.linkedin.com/feed/?shareActive=true";

// ---------- helpers ----------
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { window.location.href = "/login"; throw new Error("Signed out"); }
  if (!r.ok) throw new Error((data as { error?: string }).error || `Request failed (${r.status})`);
  return data as T;
}
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const dayKey = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
function toLocalInput(iso: string) {
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function firstLine(body: string) { return body.split("\n").find((l) => l.trim()) || ""; }
function ago(iso: string | null) {
  if (!iso) return ""; const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 60 ? `${Math.max(1, Math.round(m))}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
const isApi = (a?: Account | null) => Boolean(a && a.connected && !a.urn.startsWith("manual:"));

export default function Dashboard() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const say = useCallback((m: string) => {
    setToast(m); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);
  const load = useCallback(async () => {
    try { setS(await api<State>("/api/state")); setErr(""); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  // Read ?connected= / ?error= after mount (avoids a server/client mismatch), then clean the URL.
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected")) setBanner({ ok: true, text: `Connected: ${p.get("connected")}` });
    else if (p.get("error")) setBanner({ ok: false, text: p.get("error")! });
    if (p.size) window.history.replaceState(null, "", "/");
  }, []);

  async function act(id: string, a: PostAction, msg?: string) {
    try { await api(`/api/posts/${id}`, { method: "PATCH", body: JSON.stringify(a) }); if (msg) say(msg); await load(); }
    catch (e) { say((e as Error).message); }
  }

  if (!s) return <div className="wrap"><div className="panel empty">{err || "Loading…"}</div></div>;

  const tz = s.workspace.timezone;
  const acct = (id: string | null) => s.accounts.find((a) => a.id === id) || null;
  const drafts = s.posts.filter((p) => p.status === "draft" || p.status === "revise")
    .sort((a, b) => +new Date(a.suggested_for || a.created_at) - +new Date(b.suggested_for || b.created_at));
  const planned = s.posts.filter((p) => ["planned", "publishing", "failed"].includes(p.status))
    .sort((a, b) => +new Date(a.scheduled_for || 0) - +new Date(b.scheduled_for || 0));
  const posted = s.posts.filter((p) => p.status === "posted").sort((a, b) => +new Date(b.posted_at || 0) - +new Date(a.posted_at || 0));
  const unanswered = s.comments.filter((c) => !c.replied).length;
  const expiring = s.accounts.filter((a) => a.connected && a.token_expires_at && +new Date(a.token_expires_at) - Date.now() < 7 * 86400000);
  const current = drafts[Math.min(idx, Math.max(0, drafts.length - 1))];

  async function copy(text: string, msg: string) {
    try { await navigator.clipboard.writeText(text); say(msg); } catch { say("Copy failed. Select the text instead."); }
  }

  return (
    <div className="wrap">
      <div className="top">
        <div className="brandrow">
          <span className="hlogo"><img src="/logo-mark.svg" alt="" /></span>
          <div>
            <div className="eyebrow">{new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" })}</div>
            <h1>Post Desk</h1>
          </div>
        </div>
        <div className="stats">
          {[[drafts.length, "to review"], [planned.length, "planned"], [posted.length, "posted"], ...(unanswered ? [[unanswered, "to answer"]] : [])].map(([v, l]) => (
            <div className="stat" key={String(l)}><b>{v}</b><span>{l}</span></div>
          ))}
        </div>
      </div>

      {banner && <div className={`banner ${banner.ok ? "" : "bad"}`}>{banner.text}</div>}
      {!s.config.linkedin && <div className="banner warn">LinkedIn isn't configured yet, so posts are published by hand. Add your LinkedIn app keys to turn on auto-posting (see README).</div>}
      {expiring.map((a) => <div key={a.id} className="banner warn">The LinkedIn connection for {a.name} expires {fmt(a.token_expires_at!, tz)}. Reconnect it in Settings.</div>)}
      {s.posts.some((p) => p.status === "failed") && <div className="banner bad">A post failed to publish. See Planned below.</div>}

      <Calendar s={s} tz={tz} onJump={(id) => { const k = drafts.findIndex((d) => d.id === id); if (k >= 0) { setIdx(k); document.getElementById("review")?.scrollIntoView({ behavior: "smooth" }); } }} />

      <section id="review">
        <h2>Review <span className="count">{drafts.length ? `${drafts.length} drafts` : ""}</span></h2>
        {current ? (
          <DraftCard key={current.id + current.updated_at} post={current} s={s} tz={tz} say={say} reload={load} act={act} />
        ) : (
          <div className="panel empty">You're all caught up.{s.config.drafting ? " Generate more drafts below." : ""}</div>
        )}
        {drafts.length > 1 && (
          <div className="pager muted">
            <button className="link" disabled={idx === 0} onClick={() => setIdx(Math.max(0, idx - 1))}>← Previous</button>
            <span>{Math.min(idx, drafts.length - 1) + 1} of {drafts.length}</span>
            <button className="link" disabled={idx >= drafts.length - 1} onClick={() => setIdx(idx + 1)}>Next →</button>
          </div>
        )}
        {s.config.drafting && (
          <Generate s={s} busy={busy} setBusy={setBusy} say={say} reload={load} />
        )}
      </section>

      <section>
        <h2>Planned <span className="count">{planned.length ? `${planned.length} planned` : ""}</span></h2>
        <ul className="rows panel">
          {planned.length ? planned.map((p) => {
            const a = acct(p.account_id);
            const due = p.scheduled_for ? +new Date(p.scheduled_for) <= Date.now() : false;
            const auto = isApi(a);
            return (
              <li key={p.id} className={due ? "due" : ""}>
                <Tile iso={p.scheduled_for!} tz={tz} />
                <div className="row-main">
                  <div className="row-text">{firstLine(p.body)}</div>
                  <div className="meta">
                    {a && <span className={`chip ${a.kind === "person" ? "person" : ""}`}>{a.name}</span>}
                    {p.format === "document" && <span className="chip warn">Carousel</span>}
                    {p.status === "failed" ? <span className="chip bad">Failed</span> : p.status === "publishing" ? <span className="chip">Publishing…</span>
                      : due ? <span className="chip warn">{auto ? "Publishing on the next run" : "Due now"}</span> : <span>{fmtTime(p.scheduled_for!, tz)} · {auto ? "posts automatically" : "post by hand"}</span>}
                    {p.format === "document" && <a className="link go" href={`/api/posts/${p.id}/pdf`}>Download PDF</a>}
                  </div>
                  {p.error && <div className="muted" style={{ color: "var(--bad)", marginTop: 4 }}>{p.error}</div>}
                  <div className="acts">
                    {p.status === "failed" && <button className="link go" onClick={() => act(p.id, { action: "retry" }, "Will retry on the next run")}>Retry</button>}
                    {!auto && <button className="link go" onClick={() => { copy(p.body, `Copied. Post it as ${a?.name || "the page"}.`); window.open(a?.kind === "organization" && a.profile_url ? a.profile_url : LINKEDIN_COMPOSE, "_blank", "noopener"); }}>Copy &amp; open LinkedIn</button>}
                    {!auto && <MarkPosted id={p.id} act={act} />}
                    {p.status === "planned" && <button className="link" onClick={() => act(p.id, { action: "unplan" }, "Moved back to review")}>Move back to review</button>}
                  </div>
                </div>
              </li>
            );
          }) : <li className="empty">Nothing planned yet. Approve a draft above.</li>}
        </ul>
      </section>

      <section>
        <h2>Posted <span className="count">{posted.length ? `${posted.length}` : ""}{unanswered ? ` · ${unanswered} comment${unanswered > 1 ? "s" : ""} to answer` : ""}</span></h2>
        <ul className="rows panel">
          {posted.length ? posted.map((p) => <PostedRow key={p.id} p={p} s={s} tz={tz} act={act} copy={copy} reload={load} say={say} />)
            : <li className="empty">Published posts collect here with their links, reshares and comments.</li>}
        </ul>
      </section>

      <Settings s={s} say={say} reload={load} />

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------- pieces ----------
function Tile({ iso, tz }: { iso: string; tz: string }) {
  const d = new Date(iso);
  return (
    <div className="tile">
      <span>{d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })}</span>
      <b>{d.toLocaleDateString("en-US", { timeZone: tz, day: "numeric" })}</b>
      <span>{d.toLocaleDateString("en-US", { timeZone: tz, month: "short" })}</span>
    </div>
  );
}

function Calendar({ s, tz, onJump }: { s: State; tz: string; onJump: (id: string) => void }) {
  const today = new Date(); const todayKey = dayKey(today, tz);
  const start = new Date(today); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const byDay = new Map<string, Post>();
  for (const p of s.posts) {
    if (p.status === "rejected") continue;
    const w = p.status === "posted" ? p.posted_at : p.scheduled_for || p.suggested_for;
    if (w && !byDay.has(dayKey(new Date(w), tz))) byDay.set(dayKey(new Date(w), tz), p);
  }
  const cells: React.ReactNode[] = [];
  let lastMonth = -1;
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i % 7 === 0) {
      const end = new Date(d); end.setDate(end.getDate() + 6);
      const m = i === 0 ? d : end;
      if (m.getMonth() !== lastMonth) { cells.push(<div className="month" key={`m${i}`}>{m.toLocaleDateString("en-US", { month: "long" })}</div>); lastMonth = m.getMonth(); }
    }
    const k = dayKey(d, tz); const p = byDay.get(k);
    const past = k < todayKey;
    cells.push(
      <button key={k} className={`day ${k === todayKey ? "today" : ""} ${past ? "past" : ""} ${p ? "has" : ""}`} tabIndex={p ? 0 : -1}
        title={p ? `${p.topic}` : undefined} onClick={() => p && onJump(p.id)}>
        {d.getDate()}{p && <i className={`dot ${p.status}`} />}
      </button>,
    );
  }
  return (
    <section className="panel cal" aria-label="Posting plan">
      <div className="cal-grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div className="dow" key={d}>{d}</div>)}{cells}</div>
      <div className="legend"><span><i className="dot planned" />Planned</span><span><i className="dot draft" />Draft</span><span><i className="dot posted" />Posted</span></div>
    </section>
  );
}

function DraftCard({ post, s, tz, say, reload, act }: {
  post: Post; s: State; tz: string; say: (m: string) => void; reload: () => Promise<void>; act: (id: string, a: PostAction, msg?: string) => Promise<void>;
}) {
  const [body, setBody] = useState(post.body);
  const [when, setWhen] = useState(toLocalInput(post.suggested_for && +new Date(post.suggested_for) > Date.now() ? post.suggested_for : new Date(Date.now() + 86400000).toISOString()));
  const [accountId, setAccountId] = useState(post.account_id || "");
  const [armed, setArmed] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tells = findTells(body);
  const a = s.accounts.find((x) => x.id === accountId) || null;

  async function save() { if (body !== post.body) await act(post.id, { action: "edit", fields: { body } }); }

  async function approve() {
    if (tells.length && armed !== "approve") { setArmed("approve"); return; }
    await act(post.id, { action: "approve", scheduledFor: new Date(when).toISOString(), body, accountId: accountId || null },
      `Planned for ${fmt(new Date(when).toISOString(), tz)}`);
  }
  async function sendRewrite() {
    if (!note.trim()) return;
    setWorking(true);
    try {
      await api(`/api/posts/${post.id}`, { method: "PATCH", body: JSON.stringify({ action: "revise", note: note.trim(), body }) });
      if (s.config.drafting) { await api(`/api/posts/${post.id}/revise`, { method: "POST" }); say("Rewritten"); }
      else say("Saved your note for the rewrite");
      await reload();
    } catch (e) { say((e as Error).message); } finally { setWorking(false); }
  }
  async function upload(f: File) {
    const fd = new FormData(); fd.append("file", f);
    try { await api(`/api/posts/${post.id}/pdf`, { method: "POST", body: fd }); say("PDF attached"); await reload(); }
    catch (e) { say((e as Error).message); }
  }

  return (
    <article className="panel post">
      <div className="post-head">
        <div className={`avatar ${a?.kind === "organization" ? "org" : ""}`}>
          {a?.kind === "organization" ? <img src="/logo-mark.svg" alt="" /> : (a?.name || "?").split(" ").map((w) => w[0]).join("").slice(0, 2)}
        </div>
        <div className="who">
          <div className="name">
            {a?.name || "No account"}
            <select className="pill" aria-label="Post from" value={accountId} onChange={(e) => { setAccountId(e.target.value); act(post.id, { action: "edit", fields: { account_id: e.target.value || null } }); }}>
              <option value="">Choose account…</option>
              {s.accounts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.kind === "organization" ? "page" : "profile"})</option>)}
            </select>
          </div>
          <div className="sub">{post.topic}{post.source === "github" ? " · from what you shipped" : ""}{post.status === "revise" ? " · waiting on a rewrite" : ""}</div>
        </div>
      </div>
      <textarea className="body" aria-label="Post text" value={body} onChange={(e) => setBody(e.target.value)} onBlur={save} />
      {post.format === "document" && (
        <div className="meta" style={{ padding: "0 20px 12px" }}>
          <span className="chip warn">Carousel</span>
          <span>{post.doc_title}</span>
          <a className="link go" href={`/api/posts/${post.id}/pdf`}>{post.attachment_id ? "Download PDF" : "Preview PDF"}</a>
          <button className="link" onClick={() => fileRef.current?.click()}>Upload your own PDF</button>
          <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
      )}
      {post.note && <p className="flag">{post.note}</p>}
      {tells.length > 0 && <p className="flag">Reads like AI: {tells.join(", ")}</p>}
      {post.share_note && <p className="muted" style={{ margin: "0 20px 12px" }}>Your reshare note: “{post.share_note}”</p>}
      <div className="post-foot">
        <input type="datetime-local" aria-label="Post on" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button className="primary" onClick={approve}>{armed === "approve" ? "Approve anyway" : "Approve & plan"}</button>
        <span className="grow" />
        <button className="link" onClick={() => setNoteOpen(true)}>Rewrite</button>
        <button className="link" onClick={() => armed === "reject" ? act(post.id, { action: "reject" }, "Rejected") : setArmed("reject")}>
          {armed === "reject" ? "Confirm reject" : "Reject"}
        </button>
      </div>
      {noteOpen && (
        <div className="note-row">
          <input autoFocus placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendRewrite()} />
          <button className="secondary" disabled={working || !note.trim()} onClick={sendRewrite}>{working ? "Rewriting…" : s.config.drafting ? "Rewrite" : "Save note"}</button>
        </div>
      )}
    </article>
  );
}

function MarkPosted({ id, act }: { id: string; act: (id: string, a: PostAction, msg?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Mark posted</button>;
  return (
    <span className="inline" style={{ width: "100%" }}>
      <input autoFocus placeholder="Paste the post link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="primary" onClick={() => act(id, { action: "markPosted", url: url.trim() || null }, "Marked posted")}>Save</button>
    </span>
  );
}

function PostedRow({ p, s, tz, act, copy, reload, say }: {
  p: Post; s: State; tz: string; act: (id: string, a: PostAction, msg?: string) => Promise<void>;
  copy: (t: string, m: string) => Promise<void>; reload: () => Promise<void>; say: (m: string) => void;
}) {
  const a = s.accounts.find((x) => x.id === p.account_id);
  const ra = s.accounts.find((x) => x.id === p.reshare_account_id);
  const comments = s.comments.filter((c) => c.post_id === p.id).sort((x, y) => Number(x.replied) - Number(y.replied));
  const open = comments.filter((c) => !c.replied).length;
  const [link, setLink] = useState("");

  async function replied(id: string) {
    try { await api(`/api/comments/${id}`, { method: "PATCH", body: JSON.stringify({ replied: true }) }); await reload(); } catch (e) { say((e as Error).message); }
  }

  return (
    <li>
      <Tile iso={p.posted_at!} tz={tz} />
      <div className="row-main">
        <div className="row-text">{firstLine(p.body)}</div>
        <div className="meta">
          {a && <span className="chip">{a.name}</span>}
          {open > 0 && <span className="chip warn">{open} new</span>}
          {p.url ? <a className="link go" href={p.url} target="_blank" rel="noopener noreferrer">View post ↗</a> : null}
        </div>
        {!p.url && (
          <div className="inline">
            <input placeholder="Paste the post link" value={link} onChange={(e) => setLink(e.target.value)} />
            <button className="secondary" onClick={() => act(p.id, { action: "edit", fields: { url: link.trim() } }, "Link saved")}>Save</button>
          </div>
        )}
        {ra && p.reshare_status !== "none" && p.reshare_status !== "skipped" && (
          p.reshare_status === "done" ? <div className="box done muted">Reshared from {ra.name} ✓</div> :
          <div className="box share">
            <div className="box-h">Reshare from {ra.name}</div>
            {p.share_note && <div>“{p.share_note}”</div>}
            {p.reshare_status === "failed" && <div className="muted" style={{ color: "var(--bad)" }}>{p.reshare_error}</div>}
            <div className="acts">
              {isApi(ra) && p.reshare_status === "pending" && p.reshare_at && <span className="muted">Reshares automatically {fmt(p.reshare_at, tz)}</span>}
              {p.reshare_status === "failed" && <button className="link go" onClick={() => act(p.id, { action: "retry" }, "Will retry")}>Retry</button>}
              {(!isApi(ra) || p.reshare_status === "failed") && p.url && (
                <button className="link go" onClick={() => { if (p.share_note) copy(p.share_note, "Note copied"); window.open(p.url!, "_blank", "noopener"); }}>
                  {p.share_note ? "Copy note & open post" : "Open post"}
                </button>
              )}
              {(!isApi(ra) || p.reshare_status === "failed") && <button className="link" onClick={() => act(p.id, { action: "markReshared" }, "Marked shared")}>Mark shared</button>}
            </div>
            {!isApi(ra) && <div className="muted" style={{ fontSize: 12 }}>On the post: Repost → Repost with your thoughts → paste.</div>}
          </div>
        )}
        {comments.map((c) => (
          <div key={c.id} className={`cmt ${c.replied ? "done" : ""}`}>
            <div className="muted" style={{ fontSize: 12 }}>{c.author_name || "LinkedIn member"} · {ago(c.commented_at)}</div>
            <div className="cmt-text">{c.text}</div>
            <div className="acts">
              {c.replied ? <span className="muted">Replied ✓</span> : <>
                {p.url && <a className="link go" href={p.url} target="_blank" rel="noopener noreferrer">Reply on LinkedIn ↗</a>}
                <button className="link" onClick={() => replied(c.id)}>Mark replied</button>
              </>}
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}

function Generate({ s, busy, setBusy, say, reload }: { s: State; busy: boolean; setBusy: (b: boolean) => void; say: (m: string) => void; reload: () => Promise<void> }) {
  const [count, setCount] = useState(3);
  const [brief, setBrief] = useState("");
  async function run(fromGithub = false) {
    setBusy(true);
    try {
      const r = await api<{ created: number; message?: string }>("/api/drafts/generate", { method: "POST", body: JSON.stringify({ count, brief, fromGithub }) });
      say(r.message || `Added ${r.created} draft${r.created === 1 ? "" : "s"}`); setBrief(""); await reload();
    } catch (e) { say((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="panel gen" style={{ marginTop: 12 }}>
      <select aria-label="How many drafts" value={count} onChange={(e) => setCount(Number(e.target.value))}>
        {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} draft{n > 1 ? "s" : ""}</option>)}
      </select>
      <input placeholder="Optional direction, e.g. a carousel about staffing" value={brief} onChange={(e) => setBrief(e.target.value)} />
      <button className="primary" disabled={busy} onClick={() => run(false)}>{busy ? "Writing…" : "Generate"}</button>
      {s.config.github && <button className="secondary" disabled={busy} onClick={() => run(true)}>From this week's work</button>}
    </div>
  );
}

function Settings({ s, say, reload }: { s: State; say: (m: string) => void; reload: () => Promise<void> }) {
  const [voice, setVoice] = useState(s.workspace.voice);
  const [repo, setRepo] = useState(s.workspace.github_repo || "");
  const [tzv, setTz] = useState(s.workspace.timezone);
  const [manual, setManual] = useState({ kind: "organization" as "organization" | "person", name: "", profile_url: "" });

  async function saveWs() {
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ voice, github_repo: repo, timezone: tzv }) }); say("Saved"); await reload(); }
    catch (e) { say((e as Error).message); }
  }
  async function patchAcct(id: string, body: object) {
    try { await api(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }); await reload(); } catch (e) { say((e as Error).message); }
  }
  async function disconnect(id: string) {
    try { await api(`/api/accounts/${id}`, { method: "DELETE" }); say("Disconnected"); await reload(); } catch (e) { say((e as Error).message); }
  }
  async function addManual() {
    try { await api("/api/accounts/manual", { method: "POST", body: JSON.stringify(manual) }); setManual({ ...manual, name: "", profile_url: "" }); await reload(); }
    catch (e) { say((e as Error).message); }
  }
  async function runJob(job: string) {
    try { const r = await api<Record<string, { summary: string }>>(`/api/cron/${job}`, { method: "POST" }); say(Object.values(r).map((x) => x.summary).join(" · ")); await reload(); }
    catch (e) { say((e as Error).message); }
  }

  return (
    <details className="panel">
      <summary>Settings</summary>

      <label className="field"><span>Voice and audience notes (used for every draft)</span>
        <textarea value={voice} onChange={(e) => setVoice(e.target.value)} /></label>
      <label className="field"><span>GitHub repo for "what we shipped" drafts</span>
        <input placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
      <label className="field"><span>Time zone</span>
        <input value={tzv} onChange={(e) => setTz(e.target.value)} /></label>
      <div className="acts" style={{ marginTop: 12 }}><button className="primary" onClick={saveWs}>Save settings</button></div>

      <div className="field"><span>LinkedIn accounts</span>
        {s.accounts.map((a) => (
          <div className="acct" key={a.id}>
            <span className={`chip ${a.kind === "person" ? "person" : ""}`}>{a.kind === "organization" ? "Page" : "Profile"}</span>
            <b>{a.name}</b>
            <span className="muted">{isApi(a) ? `auto-posting · expires ${new Date(a.token_expires_at!).toLocaleDateString()}` : a.urn.startsWith("manual:") ? "posted by hand" : "disconnected"}</span>
            <span className="grow" />
            {a.kind === "organization" && (a.is_default ? <span className="muted">Default for posts</span> : <button className="link" onClick={() => patchAcct(a.id, { makeDefault: true })}>Make default</button>)}
            {a.kind === "person" && (a.is_reshare_default ? <span className="muted">Default for reshares</span> : <button className="link" onClick={() => patchAcct(a.id, { makeReshareDefault: true })}>Use for reshares</button>)}
            {isApi(a) && <button className="link" onClick={() => disconnect(a.id)}>Disconnect</button>}
          </div>
        ))}
        {s.config.linkedin ? (
          <div className="acts" style={{ marginTop: 10 }}>
            <a className="secondary" href="/api/auth/linkedin/start?kind=organization">Connect company page</a>
            <a className="secondary" href="/api/auth/linkedin/start?kind=person">Connect my profile</a>
          </div>
        ) : <p className="muted">Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to connect accounts for auto-posting.</p>}
        <div className="inline">
          <select value={manual.kind} onChange={(e) => setManual({ ...manual, kind: e.target.value as "organization" | "person" })}>
            <option value="organization">Company page</option><option value="person">Profile</option>
          </select>
          <input placeholder="Name (post by hand)" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
          <input placeholder="LinkedIn link" value={manual.profile_url} onChange={(e) => setManual({ ...manual, profile_url: e.target.value })} />
          <button className="secondary" onClick={addManual}>Add</button>
        </div>
      </div>

      <div className="field"><span>Automation</span>
        {["publish", "reshare", "comments", "autofill", "weekly-draft"].map((j) => {
          const r = s.jobs.find((x) => x.job === j);
          return (
            <div className="acct" key={j}>
              <b style={{ minWidth: 110 }}>{j}</b>
              <span className="muted" style={{ flex: 1, minWidth: 0 }}>{r ? `${ago(r.started_at)} ago · ${r.ok === false ? "failed: " : ""}${r.summary || ""}` : "hasn't run yet"}</span>
              <button className="link go" onClick={() => runJob(j)}>Run now</button>
            </div>
          );
        })}
      </div>
      <div className="acts" style={{ marginTop: 16 }}>
        <button className="link" onClick={async () => { await fetch("/api/logout", { method: "POST" }); window.location.href = "/login"; }}>Sign out</button>
      </div>
    </details>
  );
}
