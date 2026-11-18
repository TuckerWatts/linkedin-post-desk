"use client";
import { useEffect } from "react";
import "./globals.css";

/** Shown if even the page layout fails. Same plain message as error.tsx; it has to bring its own <html>. */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <div className="panel empty">
            <p>Something went wrong on this page.</p>
            <button className="primary" onClick={reset}>Try again</button>
          </div>
        </div>
      </body>
    </html>
  );
}
