// Imported first by tests that exercise job code: nothing may reach a real database or LinkedIn. Any attempt throws.
import pg from "pg";

delete process.env.DATABASE_URL;
const noDb = () => { throw new Error("database access is disabled in tests"); };
pg.Client.prototype.connect = noDb;
pg.Pool.prototype.connect = noDb;
pg.Pool.prototype.query = noDb;
globalThis.fetch = (() => { throw new Error("network is disabled in tests"); }) as typeof fetch;

/** Lets pending promise callbacks run (the fakes never touch timers or I/O). */
export const flush = () => new Promise<void>((r) => setImmediate(r));

/** A step that never returns, like a process killed mid-call. */
export const never = <T>() => new Promise<T>(() => {});

export function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A fetch() network failure, shaped like Node's real ones: TypeError("fetch failed") with the socket error as
 * its cause. Codes seen in practice: ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT (no connection made);
 * UND_ERR_SOCKET "other side closed", ECONNRESET (connection lost after the request went out).
 */
export function fetchFailed(code: string, message = `${code} (test)`): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

/** What fetch() rejects with when an AbortSignal.timeout() fires while waiting for the answer. */
export const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
