import Link from "next/link";

/** Replaces Next.js's "404: This page could not be found". */
export default function NotFound() {
  return (
    <div className="wrap">
      <div className="panel empty">
        <p>There's nothing at this address.</p>
        <Link className="secondary" href="/">Go to Post Desk</Link>
      </div>
    </div>
  );
}
