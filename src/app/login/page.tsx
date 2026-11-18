"use client";
import { useState } from "react";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    let r: Response;
    try {
      r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
    } catch {
      setBusy(false); setErr("Couldn't reach Post Desk. Check your connection and try again."); return;
    }
    setBusy(false);
    if (r.ok) window.location.href = "/";
    else setErr((await r.json().catch(() => ({}))).error || "Couldn't sign in.");
  }

  return (
    <form className="panel login" onSubmit={submit}>
      <div className="brandrow">
        <span className="hlogo"><img src="/logo-mark.svg" alt="" /></span>
        <h1 style={{ fontSize: 30 }}>Post Desk</h1>
      </div>
      <label className="field">
        <span>Password</span>
        <input id="password" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      {err && <div className="banner bad">{err}</div>}
      <button className="primary" disabled={busy || !pw}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
