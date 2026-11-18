"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "@/lib/accounts";
import type { Comment, Post, PostAction, Slide } from "@/lib/posts";
import { looksLikeId } from "@/lib/names";
import { LIMITS, MAX_POINTS, slideLabel, starterSlides } from "@/lib/slides";
import { POSTING_WINDOWS, WINDOW_KEYS } from "@/lib/slots";
import { findTells } from "@/lib/tells";
import { timeZoneOptions } from "@/lib/time";
import { carouselPalette, DEFAULT_CAROUSEL_COLOR } from "@/lib/colors";
import { combineNotes, postingStatus, type JobRun } from "@/lib/explain";
import { needsReconnect, todos, type Todo } from "@/lib/todo";

type State = {
  workspace: { id: string; name: string; timezone: string; voice: string; posting_windows: string[]; carousel_color: string | null };
  accounts: Account[];
  posts: Post[];
  comments: Comment[];
  jobs: JobRun[];
  config: { linkedin: boolean; drafting: boolean; companyLogo: boolean };
};

const LINKEDIN_COMPOSE = "https://www.linkedin.com/feed/?shareActive=true";

// ---------- helpers ----------
/** Calls the app's API. Errors carry only plain messages: the server sends nothing technical, and these fallbacks aren't either. */
async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new Error("Couldn't reach Post Desk. Check your connection and try again.");
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { window.location.href = "/login"; throw new Error("Signed out"); }
  // The host rejects oversized uploads before the app sees them (on Vercel, around 4.5 MB), so say so.
  if (r.status === 413) throw new Error("That file is too big to upload. Try a smaller PDF.");
  if (!r.ok) throw new Error((data as { error?: string }).error || "Something went wrong. Try again in a minute.");
  return data as T;
}
const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const dayKey = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
function toLocalInput(iso: string) {
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** "Acme Coffee Roasters" → "AC". Stands in for a picture the app doesn't have. */
function initials(name?: string | null) {
  return (name || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
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
  const todo = todos(s.posts, s.accounts);
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
          {[...(todo.length ? [[todo.length, "to do"]] : []), [drafts.length, "to review"], [planned.length, "planned"], [posted.length, "posted"], ...(unanswered ? [[unanswered, "to answer"]] : [])].map(([v, l]) => (
            <div className="stat" key={String(l)}><b>{v}</b><span>{l}</span></div>
          ))}
        </div>
      </div>

      {banner && <div className={`banner ${banner.ok ? "" : "bad"}`}>{banner.text}</div>}
      {!s.config.linkedin && <div className="banner warn">Auto-posting isn't set up yet, so posts are published by hand for now.</div>}
      {expiring.map((a) => <div key={a.id} className="banner warn">The LinkedIn connection for {a.name} expires {fmt(a.token_expires_at!, tz)}. Reconnect it in Settings.</div>)}

      <TodoList items={todo} tz={tz} act={act} copy={copy} />

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
          <Generate busy={busy} setBusy={setBusy} say={say} reload={load} />
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
                      : due ? <span className="chip warn">{auto ? "Publishing shortly" : "Due now"}</span> : <span>{fmtTime(p.scheduled_for!, tz)} · {auto ? "posts automatically" : "post by hand"}</span>}
                    {p.format === "document" && <a className="link go" href={`/api/posts/${p.id}/pdf`}>Download PDF</a>}
                  </div>
                  <Problem text={p.problem} />
                  <div className="acts">
                    {p.status === "failed" ? <FixActions kind="post" p={p} a={a} act={act} copy={copy} /> : <>
                      {!auto && <button className="link go" onClick={() => { copy(p.body, `Copied. Post it as ${a?.name || "the page"}.`); window.open(a?.kind === "organization" && a.profile_url ? a.profile_url : LINKEDIN_COMPOSE, "_blank", "noopener"); }}>Copy &amp; open LinkedIn</button>}
                      {!auto && <MarkPosted id={p.id} act={act} />}
                      {p.status === "planned" && <button className="link" onClick={() => act(p.id, { action: "unplan" }, "Moved back to review")}>Move back to review</button>}
                    </>}
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

type Act = (id: string, a: PostAction, msg?: string) => Promise<void>;
type Copy = (text: string, msg: string) => Promise<void>;

function TodoList({ items, tz, act, copy }: { items: Todo[]; tz: string; act: Act; copy: Copy }) {
  if (!items.length) return null;
  return (
    <section id="todo">
      <h2>To do <span className="count">{items.length}</span></h2>
      <ul className="rows panel">
        {items.map(({ kind, post: p, account: a, when }) => (
          <li key={`${kind}-${p.id}`}>
            <Tile iso={when} tz={tz} />
            <div className="row-main">
              <div className="row-text">{firstLine(p.body)}</div>
              <div className="meta">
                <span className="chip bad">{kind === "post" ? "Post" : "Reshare"}</span>
                {a && <span className={`chip ${a.kind === "person" ? "person" : ""}`}>{a.name}</span>}
                {!a && <span>{kind === "post" ? "Posting" : "Resharing"} account was removed</span>}
              </div>
              <Problem text={(kind === "post" ? p.problem : p.reshare_problem) ?? "This didn't go out as planned."} />
              <div className="acts"><FixActions kind={kind} p={p} a={a} act={act} copy={copy} /></div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What you can do about a failed post or reshare, the same everywhere it appears. Reconnecting comes first when the
 * account's token no longer works (a Retry would fail the same way); otherwise checking LinkedIn comes first, then
 * recording what happened, and Retry last, because retrying something that did go out posts it twice.
 */
function FixActions({ kind, p, a, act, copy }: { kind: "post" | "reshare"; p: Post; a: Account | null; act: Act; copy: Copy }) {
  const reconnect = needsReconnect(a);
  return (
    <>
      {reconnect && a && <a className="link go" href={`/api/auth/linkedin/start?kind=${a.kind}`} title={`Reconnect ${a.name}; Retry comes back once it's connected`}>Reconnect to retry</a>}
      {a?.profile_url && <a className="link go" href={a.profile_url} target="_blank" rel="noopener noreferrer" title={`Open ${a.name} on LinkedIn`}>Check on LinkedIn ↗</a>}
      {kind === "reshare" && p.url && <OpenForReshare p={p} copy={copy} />}
      {kind === "post" ? <MarkPosted id={p.id} act={act} />
        : <button className="link" onClick={() => act(p.id, { action: "markReshared" }, "Marked shared")}>Mark shared</button>}
      {a && !reconnect && <button className="link" onClick={() => act(p.id, { action: "retry" }, "Will try again shortly")}>Retry</button>}
    </>
  );
}

/** Why a post or reshare didn't go out, in plain words (worked out on the server; see explain.ts). */
function Problem({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <div className="muted" style={{ color: "var(--bad)", marginTop: 4 }}>{text}</div>;
}

/**
 * An account's name in Settings, with Rename. The chosen name is used everywhere, including the top of carousel slides.
 * Accounts saved by ID before names were checked show "Name missing" until renamed.
 */
function AccountName({ a, say, reload }: { a: Account; say: (m: string) => void; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const missing = a.name_missing;
  async function save(name: string) {
    try {
      await api(`/api/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ display_name: name }) });
      setEditing(false); say(name.trim() ? "Renamed" : "Back to the original name"); await reload();
    } catch (e) { say((e as Error).message); }
  }
  if (editing) {
    return (
      <span className="inline">
        <input autoFocus aria-label="Account name" value={value} placeholder="The name people know it by"
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save(value)} />
        <button className="secondary" onClick={() => save(value)}>Save</button>
        <button className="link" onClick={() => setEditing(false)}>Cancel</button>
      </span>
    );
  }
  const original = a.display_name && !looksLikeId(a.linkedin_name) ? a.linkedin_name : null;
  return (
    <>
      <b style={missing ? { color: "var(--bad)" } : undefined}>{missing ? "Name missing" : a.name}</b>
      <button className={`link${missing ? " go" : ""}`} onClick={() => { setValue(missing ? "" : a.name); setEditing(true); }}>Rename</button>
      {original && <button className="link" title={`Originally “${original}”`} onClick={() => save("")}>Undo rename</button>}
    </>
  );
}

/**
 * The carousel color, with a preview of the colors slides will use, including any adjustment made to keep text readable
 * (see carouselPalette), so nobody is surprised by the PDF.
 */
function CarouselColor({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  const p = carouselPalette(value);
  return (
    <div className="field"><span>Carousel color</span>
      <div className="inline" style={{ alignItems: "center" }}>
        <input type="color" aria-label="Carousel color" value={value ?? DEFAULT_CAROUSEL_COLOR} onChange={(e) => onChange(e.target.value)}
          style={{ width: 44, height: 34, padding: 2 }} />
        <span className="swatches" aria-label="How slides will look">
          <span style={{ background: p.dark, color: p.onDarkTitle }}>Aa</span>
          <span style={{ background: p.tint, color: p.ink }}>Aa</span>
          <span style={{ background: p.paper, color: p.ink, border: `1px solid ${p.line}` }}>Aa</span>
        </span>
        {value ? <button className="link" onClick={() => onChange(null)}>Use neutral</button> : <span className="muted">Neutral</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Used for carousels built from slides. Text turns light or dark to suit the color, and a few in-between colors are deepened slightly, so slides stay easy to read.</div>
    </div>
  );
}

/** Time zone picker: cities with their UTC offset, grouped by region. A text field only if the browser can't list zones. */
function TimeZoneSelect({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const groups = useMemo(() => timeZoneOptions(value), [value]);
  if (!groups.length) return <input value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((g) => (
        <optgroup key={g.region} label={g.region}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** Opens the company post to reshare it by hand, copying the personal note first. */
function OpenForReshare({ p, copy }: { p: Post; copy: Copy }) {
  return (
    <button className="link go" onClick={() => { if (p.share_note) copy(p.share_note, "Note copied"); window.open(p.url!, "_blank", "noopener"); }}>
      {p.share_note ? "Copy note & open post" : "Open post"}
    </button>
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
  const [editingSlides, setEditingSlides] = useState<Slide[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tells = findTells(body);
  const a = s.accounts.find((x) => x.id === accountId) || null;

  async function save() { if (body !== post.body) await act(post.id, { action: "edit", fields: { body } }); }

  async function approve() {
    if (editingSlides) { say("Save or cancel your slide changes first."); return; }
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
          {a?.kind === "organization" && s.config.companyLogo ? <img src="/logo-mark.png" alt="" /> : initials(a?.name)}
        </div>
        <div className="who">
          <div className="name">
            {a?.name || "No account"}
            <select className="pill" aria-label="Post from" value={accountId} onChange={(e) => { setAccountId(e.target.value); act(post.id, { action: "edit", fields: { account_id: e.target.value || null } }); }}>
              <option value="">Choose account…</option>
              {s.accounts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.kind === "organization" ? "page" : "profile"})</option>)}
            </select>
          </div>
          <div className="sub">{post.topic}{post.status === "revise" ? " · waiting on a rewrite" : ""}</div>
        </div>
      </div>
      <textarea className="body" aria-label="Post text" value={body} onChange={(e) => setBody(e.target.value)} onBlur={save} />
      {post.format === "document" && (
        <div className="meta" style={{ padding: "0 20px 12px" }}>
          <span className="chip warn">Carousel</span>
          <span>{post.doc_title}</span>
          {(post.slides?.length || post.attachment_id) && (
            <a className="link go" href={`/api/posts/${post.id}/pdf`}>{post.attachment_id ? "Download PDF" : "Preview PDF"}</a>
          )}
          {!editingSlides && (
            <button className="link go" onClick={() => setEditingSlides(post.slides?.length ? post.slides : starterSlides(post.topic, body))}>
              {post.slides?.length ? "Edit slides" : "Write slides"}
            </button>
          )}
          <button className="link" onClick={() => fileRef.current?.click()}>Upload your own PDF</button>
          <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
      )}
      {editingSlides && (
        <SlideEditor post={post} initial={editingSlides} usesUpload={Boolean(post.attachment_id)} act={act} say={say}
          onClose={() => setEditingSlides(null)} />
      )}
      {post.note && <p className="flag">{post.note}</p>}
      {tells.length > 0 && <p className="flag">Reads like AI: {tells.join(", ")}</p>}
      {post.share_note && <p className="muted" style={{ margin: "0 20px 12px" }}>Your reshare note: “{post.share_note}”</p>}
      <div className="post-foot">
        <input type="datetime-local" aria-label="Post on" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button className="primary" onClick={approve}>{armed === "approve" ? "Approve anyway" : "Approve & plan"}</button>
        <span className="grow" />
        {post.format !== "document" && !editingSlides && (
          <button className="link" onClick={() => setEditingSlides(post.slides?.length ? post.slides : starterSlides(post.topic, body))}>Make it a carousel</button>
        )}
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

/**
 * Edits a carousel's slides: a cover, numbered points (add, remove, reorder, optional quote) and a closing slide.
 * Saving switches the post to a carousel built from these slides. The post text above becomes its caption.
 */
function SlideEditor({ post, initial, usesUpload, act, say, onClose }: {
  post: Post; initial: Slide[]; usesUpload: boolean; act: Act; say: (m: string) => void; onClose: () => void;
}) {
  const [slides, setSlides] = useState<Slide[]>(initial);
  const [deck, setDeck] = useState(post.doc_title || post.topic);
  const [quoteOpen, setQuoteOpen] = useState<number[]>([]);
  const points = slides.filter((x) => x.kind === "point").length;
  const update = (i: number, patch: Partial<Slide>) => setSlides(slides.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...slides];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setSlides(next);
    setQuoteOpen([]); // opened-but-empty quote boxes would otherwise stay at the old position
  };
  const remove = (i: number) => { setSlides(slides.filter((_, j) => j !== i)); setQuoteOpen([]); };
  const addPoint = () => setSlides([...slides.slice(0, -1), { kind: "point", title: "" }, slides[slides.length - 1]]);
  const placeholder: Record<Slide["kind"], [string, string]> = {
    cover: ["What's this carousel about?", "One line under the title (optional)"],
    point: ["The point, in a few words", "A sentence or two (optional)"],
    end: ["A question or takeaway to finish on", "A line under it (optional)"],
  };

  async function save() {
    await act(post.id, { action: "setSlides", slides, docTitle: deck }, "Slides saved");
  }
  /** Opens the PDF for the slides as they are now, saved or not. */
  async function preview() {
    const tab = window.open("", "_blank"); // opened right away, so the browser doesn't block it as a pop-up
    const fail = (m: string) => { tab?.close(); say(m); };
    try {
      const r = await fetch(`/api/posts/${post.id}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slides, docTitle: deck }),
      });
      if (r.status === 401) { tab?.close(); window.location.href = "/login"; return; }
      if (!r.ok) return fail(((await r.json().catch(() => ({}))) as { error?: string }).error || "Couldn't make the preview. Try again in a minute.");
      const url = URL.createObjectURL(await r.blob());
      if (!tab) { window.open(url, "_blank"); return; }
      // Show it in a page with a readable tab title, rather than the PDF's random address.
      tab.document.title = `Preview: ${deck || post.topic}`;
      tab.document.body.style.margin = "0";
      const frame = tab.document.createElement("iframe");
      frame.src = url;
      frame.title = "Carousel preview";
      frame.style.cssText = "border:0;width:100vw;height:100vh;display:block";
      tab.document.body.appendChild(frame);
    } catch {
      fail("Couldn't reach Post Desk. Check your connection and try again.");
    }
  }
  async function makeTextPost() {
    await act(post.id, { action: "setSlides", slides: null }, "Now a text post");
  }

  return (
    <div className="slides-editor">
      {slides.map((sl, i) => {
        const tells = findTells(`${sl.title}\n${sl.body ?? ""}\n${sl.quote ?? ""}`);
        const showQuote = sl.kind === "point" && (Boolean(sl.quote) || quoteOpen.includes(i));
        return (
          <div className="slide-edit" key={i}>
            <div className="slide-head">
              <b>{slideLabel(slides, i)}</b>
              {sl.kind === "point" && (
                <span className="slide-tools">
                  <button className="link" disabled={slides[i - 1]?.kind !== "point"} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button className="link" disabled={slides[i + 1]?.kind !== "point"} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  {points > 1 && <button className="link" onClick={() => remove(i)}>Remove</button>}
                </span>
              )}
            </div>
            <input aria-label={`${slideLabel(slides, i)} title`} placeholder={placeholder[sl.kind][0]} maxLength={LIMITS.title}
              value={sl.title} onChange={(e) => update(i, { title: e.target.value })} />
            <textarea aria-label={`${slideLabel(slides, i)} text`} placeholder={placeholder[sl.kind][1]} maxLength={LIMITS.body} rows={2}
              value={sl.body ?? ""} onChange={(e) => update(i, { body: e.target.value })} />
            {showQuote && (
              <div className="inline" style={{ marginTop: 0 }}>
                <input aria-label="Quote" placeholder="A short quote (optional)" maxLength={LIMITS.quote}
                  value={sl.quote ?? ""} onChange={(e) => update(i, { quote: e.target.value })} />
                <input aria-label="Who said it" placeholder="Who said it, or where" maxLength={LIMITS.quoteLabel} style={{ maxWidth: 200 }}
                  value={sl.quoteLabel ?? ""} onChange={(e) => update(i, { quoteLabel: e.target.value })} />
              </div>
            )}
            {sl.kind === "point" && !showQuote && (
              <button className="link" style={{ justifySelf: "start" }} onClick={() => setQuoteOpen([...quoteOpen, i])}>Add a quote</button>
            )}
            {tells.length > 0 && <p className="flag" style={{ margin: 0 }}>Reads like AI: {tells.join(", ")}</p>}
          </div>
        );
      })}
      <div className="acts">
        {points < MAX_POINTS && <button className="link go" onClick={addPoint}>Add a point</button>}
      </div>
      <label className="field" style={{ marginTop: 8 }}><span>Deck title (bottom of each slide)</span>
        <input maxLength={LIMITS.deck} value={deck} onChange={(e) => setDeck(e.target.value)} /></label>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        The post text above is the caption people read before they swipe.
        {usesUpload ? " Saving these slides replaces your uploaded PDF." : ""}
      </p>
      <div className="acts" style={{ marginTop: 10 }}>
        <button className="primary" onClick={save}>Save slides</button>
        <button className="secondary" onClick={preview}>Preview</button>
        <button className="link" onClick={onClose}>Cancel</button>
        <span className="grow" />
        {post.format === "document" && <button className="link" onClick={makeTextPost}>Make it a text post</button>}
      </div>
    </div>
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
            {p.reshare_status === "failed" && <Problem text={p.reshare_problem} />}
            <div className="acts">
              {p.reshare_status === "failed" ? <FixActions kind="reshare" p={p} a={ra ?? null} act={act} copy={copy} /> : <>
                {isApi(ra) && p.reshare_status === "pending" && p.reshare_at && <span className="muted">Reshares automatically {fmt(p.reshare_at, tz)}</span>}
                {p.reshare_status === "resharing" && <span className="muted">Resharing…</span>}
                {!isApi(ra) && p.url && <OpenForReshare p={p} copy={copy} />}
                {!isApi(ra) && <button className="link" onClick={() => act(p.id, { action: "markReshared" }, "Marked shared")}>Mark shared</button>}
              </>}
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

function Generate({ busy, setBusy, say, reload }: { busy: boolean; setBusy: (b: boolean) => void; say: (m: string) => void; reload: () => Promise<void> }) {
  const [count, setCount] = useState(3);
  const [brief, setBrief] = useState("");
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ created: number }>("/api/drafts/generate", { method: "POST", body: JSON.stringify({ count, brief }) });
      say(`Added ${r.created} draft${r.created === 1 ? "" : "s"}`); setBrief(""); await reload();
    } catch (e) { say((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="panel gen" style={{ marginTop: 12 }}>
      <select aria-label="How many drafts" value={count} onChange={(e) => setCount(Number(e.target.value))}>
        {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} draft{n > 1 ? "s" : ""}</option>)}
      </select>
      <input placeholder="Optional direction, e.g. a carousel about a recent project" value={brief} onChange={(e) => setBrief(e.target.value)} />
      <button className="primary" disabled={busy} onClick={run}>{busy ? "Writing…" : "Generate"}</button>
    </div>
  );
}

function Settings({ s, say, reload }: { s: State; say: (m: string) => void; reload: () => Promise<void> }) {
  const [voice, setVoice] = useState(s.workspace.voice);
  const [tzv, setTz] = useState(s.workspace.timezone);
  const [windows, setWindows] = useState<string[]>(s.workspace.posting_windows);
  const [color, setColor] = useState<string | null>(s.workspace.carousel_color);
  const [manual, setManual] = useState({ kind: "organization" as "organization" | "person", name: "", profile_url: "" });

  async function saveWs() {
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ voice, timezone: tzv, posting_windows: windows, carousel_color: color }) }); say("Saved"); await reload(); }
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
  const posting = postingStatus(s.jobs);
  async function runJob(job: string) {
    // A failed run answers 500 with each job's note, so read the body rather than treating it as a request error.
    try {
      const r = await fetch(`/api/cron/${job}`, { method: "POST" });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const data = (await r.json().catch(() => null)) as Record<string, { note?: string }> | null;
      const notes = data && !("error" in data) ? Object.values(data).map((x) => x.note) : [];
      say(notes.length ? combineNotes(notes) : "Couldn't check right now. Try again in a minute.");
      await reload();
    } catch { say("Couldn't run it. Try again in a minute."); }
  }

  return (
    <details className="panel">
      <summary>Settings</summary>

      <label className="field"><span>Voice and audience notes (used for every draft)</span>
        <textarea value={voice} onChange={(e) => setVoice(e.target.value)} /></label>
      <label className="field"><span>Time zone</span>
        <TimeZoneSelect value={tzv} onChange={setTz} /></label>
      <div className="field"><span>Usual posting times</span>
        <div className="windows">
          {WINDOW_KEYS.map((k) => (
            <label key={k} className="window">
              <input type="checkbox" checked={windows.includes(k)}
                onChange={(e) => setWindows(e.target.checked ? [...windows, k] : windows.filter((w) => w !== k))} />
              {POSTING_WINDOWS[k].label} <span className="muted">{POSTING_WINDOWS[k].hint}</span>
            </label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>New drafts get a suggested time in one of these, 2–3 days apart, at an uneven minute so it doesn't look scheduled.</div>
      </div>
      <CarouselColor value={color} onChange={setColor} />
      <div className="acts" style={{ marginTop: 12 }}><button className="primary" onClick={saveWs}>Save settings</button></div>

      <div className="field"><span>LinkedIn accounts</span>
        {s.accounts.map((a) => (
          <div className="acct" key={a.id}>
            <span className={`chip ${a.kind === "person" ? "person" : ""}`}>{a.kind === "organization" ? "Page" : "Profile"}</span>
            <AccountName a={a} say={say} reload={reload} />
            <span className="muted" style={needsReconnect(a) && a.connected ? { color: "var(--bad)" } : undefined}>
              {needsReconnect(a) ? (a.connected ? "needs reconnecting" : "disconnected")
                : isApi(a) ? `auto-posting · expires ${new Date(a.token_expires_at!).toLocaleDateString()}` : "posted by hand"}
            </span>
            {needsReconnect(a) && <a className="link go" href={`/api/auth/linkedin/start?kind=${a.kind}`}>Reconnect</a>}
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

      {s.accounts.some(isApi) && (
        <div className="field"><span>Automatic posting</span>
          <div className="acct">
            <span className="muted" style={{ flex: 1, minWidth: 0, ...(posting.bad ? { color: "var(--bad)" } : {}) }}>
              {posting.at ? `Checked ${ago(posting.at)} ago · ` : ""}{posting.text}
            </span>
            <button className="link go" onClick={() => runJob("all")}>Check now</button>
          </div>
        </div>
      )}
      <div className="acts" style={{ marginTop: 16 }}>
        <button className="link" onClick={async () => { await fetch("/api/logout", { method: "POST" }); window.location.href = "/login"; }}>Sign out</button>
      </div>
    </details>
  );
}
