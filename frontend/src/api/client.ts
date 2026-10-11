/**
 * The one place that talks to the DevNexus API.
 *
 * Two conventions from the backend shape everything here:
 *
 *  1. EVERY endpoint is a GET and every parameter travels in the query string,
 *     including the ones that write. There are no request bodies anywhere, so
 *     this client has no `body` concept at all.
 *
 *  2. Every response is enveloped: `{ok: true, ...}` or `{ok: false, error}`.
 *     A failure can therefore arrive with HTTP 200, so checking `res.ok` alone
 *     is not enough — `request()` inspects the envelope too and throws a
 *     DevNexusError either way. Callers get the unwrapped success shape or an
 *     exception; they never branch on `ok` themselves.
 *
 * Because writes are GETs, a cached response would silently replay a write or
 * serve a stale read. The server sends `Cache-Control: no-store`; we ask for
 * no-store on our side as well so an intermediate cache cannot undo that.
 */

import { DevNexusError } from './types';

export { DevNexusError };

const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

if (!BASE && import.meta.env.DEV) {
  console.warn('VITE_API_BASE is not set — API calls will fail. See .env.example.');
}

/** A query value we know how to serialise. `undefined` and `''` are dropped. */
export type ParamValue = string | number | boolean | undefined | null;
export type Params = Record<string, ParamValue>;

/**
 * Serialise params, dropping the empty ones.
 *
 * Omitting a parameter and sending it empty are NOT the same to this backend:
 * `/rules/update?name=` would be read as "set the name to blank", while leaving
 * it out means "don't touch the name". Callers pass `undefined` for absent, and
 * must pass a deliberate `''` only when they really mean to clear a field.
 */
export function toQuery(params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, typeof v === 'boolean' ? String(v) : String(v));
  }
  return qs.toString();
}

/**
 * The URL budget. API Gateway rejects very long request lines, and because
 * complex objects are sent as one URL-encoded JSON parameter it is possible to
 * build a request that is too long — a bulk price call or a large schema will
 * do it. Catching it here produces a message the UI can show, instead of an
 * opaque gateway error with no body to read.
 */
const MAX_URL = 6000;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number;
}

/**
 * How long to wait before giving up on a request.
 *
 * Measured against the live API, these endpoints answer in 60-225ms, so 8s is
 * already ~35x the slowest observed response and only ever trips on a
 * connection that is not coming back.
 *
 * It was 20s, which was far too generous: when a VPN silently black-holes the
 * route (packets dropped rather than refused) every attempt hangs for the full
 * timeout, and with the retry on top the UI sat on a spinner for a minute
 * before admitting anything was wrong. Failing fast and retrying is much
 * better than hanging slowly.
 *
 * Generation endpoints override this; see aiApi.configure.
 */
const DEFAULT_TIMEOUT = 8_000;

/**
 * How many times a GET is retried after the connection itself fails.
 *
 * Every endpoint here is a read or an idempotent write keyed by a caller-supplied
 * id, so repeating one is safe. A single dropped connection used to surface as a
 * full-width "Could not reach DevNexus" banner that then sat there permanently
 * on any query without polling — one blip, and the page looked offline while all
 * its data was present. Retrying absorbs that.
 *
 * Only CONNECTION failures are retried. An HTTP error means the server answered
 * and retrying would just repeat the same answer more slowly.
 */
const NETWORK_RETRIES = 2;
const RETRY_BASE_MS = 400;

async function request<T>(
  path: string,
  params: Params = {},
  opts: RequestOptions = {},
  attempt = 0,
): Promise<T> {
  const qs = toQuery(params);
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;

  if (url.length > MAX_URL) {
    throw new DevNexusError(
      0,
      'request_too_large',
      'This request is too large to send in one call. Try fewer items at a time.',
    );
  }

  // Our own timeout, combined with any caller-supplied signal. Without this a
  // hung request leaves a spinner on screen forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // the caller cancelled; let it through
    if (ctrl.signal.aborted) {
      throw new DevNexusError(
        0,
        'timeout',
        // Named so a repeated failure is diagnosable, and pointed at the cause
        // that actually produces this: a VPN or proxy silently dropping the
        // route. The API answers in well under a second when it is reachable,
        // so a timeout here is almost never the server being slow.
        `No response from DevNexus for ${path}. If you are on a VPN or proxy, ` +
          'try turning it off.',
        { endpoint: path, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT },
      );
    }

    if (attempt < NETWORK_RETRIES) {
      // Exponential, jittered: a blip affecting several parallel dashboard
      // requests must not have them all retry in lockstep.
      const wait = RETRY_BASE_MS * 2 ** attempt * (0.7 + Math.random() * 0.6);
      await new Promise((r) => setTimeout(r, wait));
      if (opts.signal?.aborted) throw err;
      return request<T>(path, params, opts, attempt + 1);
    }

    throw new DevNexusError(
      0,
      'network',
      // Names the endpoint. "network" alone told nobody which of a dozen
      // parallel dashboard calls had failed, which made it undiagnosable.
      `Could not reach DevNexus for ${path}. Check your connection and try again.`,
      { endpoint: path, attempts: attempt + 1 },
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means something upstream of the application answered —
    // a gateway timeout page, for instance. Surface it as a server error
    // rather than letting a parse exception escape.
    throw new DevNexusError(
      res.status,
      'bad_response',
      `The server returned an unexpected response (HTTP ${res.status}).`,
    );
  }

  const envelope = (payload ?? {}) as {
    ok?: boolean;
    error?: { code?: string; message?: string; [k: string]: unknown };
  };

  if (!res.ok || envelope.ok === false) {
    const e = envelope.error ?? {};
    throw new DevNexusError(
      res.status,
      e.code ?? `http_${res.status}`,
      e.message ?? httpMessage(res.status),
      { ...(e as Record<string, unknown>), endpoint: path },
    );
  }

  return payload as T;
}

/** Human wording for the cases where the server sent no message of its own. */
function httpMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'That could not be found.';
  if (status === 429) return 'Too many requests. Give it a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return `Request failed (HTTP ${status}).`;
}

/* ===========================================================================
   Session
   ===========================================================================

   The session token is an opaque string the server can revoke instantly, and
   it rides in the query string like everything else. It is held in module
   scope and mirrored to localStorage so a refresh does not sign the user out.

   It is NOT in React state on purpose: `api.*` functions are called from
   loaders and event handlers that have no access to a hook, and threading a
   token through every call site would be noise at a hundred places. The auth
   provider is the only thing that sets it.
*/

const TOKEN_KEY = 'devnexus.token';

let token: string | null = readStoredToken();

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private windows and blocked site data throw on access. A session that
    // lives only in memory still works for this tab.
    return null;
  }
}

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* memory-only session; nothing more we can do */
  }
}

/** Notified when a call comes back 401, so the shell can bounce to sign-in. */
type ExpiryListener = () => void;
const expiryListeners = new Set<ExpiryListener>();

export function onSessionExpired(fn: ExpiryListener): () => void {
  expiryListeners.add(fn);
  return () => expiryListeners.delete(fn);
}

/**
 * An authenticated call: injects `token`, and reacts to its rejection.
 *
 * A 401 here means the token is gone server-side, so we clear it and tell the
 * app once. Leaving a dead token in place would make every subsequent screen
 * fail individually with its own error card.
 */
async function auth<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
  if (!token) {
    throw new DevNexusError(401, 'unauthenticated', 'Please sign in to continue.');
  }
  try {
    return await request<T>(path, { ...params, token }, opts);
  } catch (err) {
    if (err instanceof DevNexusError && err.status === 401) {
      setToken(null);
      for (const fn of expiryListeners) fn();
    }
    throw err;
  }
}

/** An unauthenticated call (sign-in, sign-up, the public catalog, health). */
function pub<T>(path: string, params: Params = {}, opts?: RequestOptions): Promise<T> {
  return request<T>(path, params, opts);
}

export { auth, pub, request };

/**
 * Encode an object as one URL-encoded JSON parameter.
 *
 * The GET-only convention has no way to express nesting, so anything
 * structured — a rule's conditions, a domain schema, what-if overrides — is
 * sent as a single JSON string. This is the only correct way to build those
 * params, so every call site goes through it rather than calling
 * JSON.stringify inline and getting the escaping subtly wrong.
 */
export function json(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

/** Join a list for the `item_ids` / `rule_ids` / `versions` style params. */
export function csv(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.join(',');
}
