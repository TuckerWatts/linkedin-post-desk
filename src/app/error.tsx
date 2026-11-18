"use client";
import { useEffect } from "react";

/** Replaces Next.js's "Application error: a client-side exception has occurred". The details go to the console. */
export default function PageError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="wrap">
      <div className="panel empty">
        <p>Something went wrong on this page.</p>
        <button className="primary" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
