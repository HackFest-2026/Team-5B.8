import { useCallback, useEffect, useRef, useState } from 'react';
import { DevNexusError } from '@/api/client';

/**
 * The data-fetching primitive the whole app uses.
 *
 * No query library. The requirement is a GET-only API with no caching allowed
 * (writes are GETs, so a cache would replay them), which removes most of what a
 * query library is for. What is actually needed is: loading, error, data, a
 * refetch, and cancellation on unmount — about forty lines, with no dependency
 * and no cache invalidation to get wrong.
 *
 * Two details that matter more than they look:
 *
 *  - `deps` drives refetching, so a changed project id or time range refetches
 *    automatically. A stale response from the PREVIOUS deps is discarded rather
 *    than written over the new one, because responses can arrive out of order
 *    and the dashboard switching projects must never show the old project's
 *    numbers under the new project's name.
 *
 *  - The loading flag stays true across a deps change rather than flashing
 *    data→empty→data.
 */

export interface AsyncState<T> {
  data: T | null;
  error: DevNexusError | null;
  loading: boolean;
  /** True only on the first load, so a refresh does not replace the screen
   *  with skeletons when there is already something to look at. */
  initialLoading: boolean;
  refetch: () => void;
}

export interface AsyncOptions {
  /** Skip the call entirely — for a query that needs a value it does not have yet. */
  enabled?: boolean;
  /** Milliseconds between automatic refetches. Omit for none. */
  pollMs?: number;
}

/** Everything refreshes on its own: a read with no explicit pollMs still polls
 *  at this cadence, and any slower explicit interval is clamped to MAX so the
 *  whole console stays effectively real-time. Opt out with `pollMs: 0`. */
const DEFAULT_POLL_MS = 6000;
const MAX_POLL_MS = 10000;

export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: AsyncOptions = {},
): AsyncState<T> {
  const { enabled = true, pollMs } = opts;
  // Default to live polling; clamp slow intervals; 0 disables entirely.
  const effectivePoll =
    pollMs === 0 ? 0 : Math.min(pollMs ?? DEFAULT_POLL_MS, MAX_POLL_MS);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DevNexusError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  // The function identity changes every render (callers pass a closure), so it
  // lives in a ref and is deliberately NOT a dependency of the effect.
  // Including it would refetch on every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Monotonic request id: only the newest request may write state.
  const latest = useRef(0);

  /**
   * Automatic recovery from a CONNECTION failure.
   *
   * A query without `pollMs` used to fail once and then sit there showing an
   * error forever, even after the network came back — the user had to notice
   * the banner and press Retry. On a machine whose link to the API drops for a
   * few minutes (observed: the API host unreachable while everything else was
   * fine), that is the entire bug: the data was never gone, the page just
   * stopped asking for it.
   *
   * So a network/timeout failure schedules its own retry, backing off 3s, 6s,
   * 12s, 24s up to 30s, and keeps trying until it succeeds. Recovery then clears
   * the error by itself.
   *
   * Only connection failures are retried this way. A 4xx is a real answer and
   * retrying it forever would be a loop that never ends and never helps.
   */
  const retryTimer = useRef<number | null>(null);
  const retryAttempt = useRef(0);

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  useEffect(() => clearRetry, [clearRetry]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++latest.current;
    const ctrl = new AbortController();
    setLoading(true);

    fnRef
      .current(ctrl.signal)
      .then((result) => {
        if (id !== latest.current) return; // a newer request has taken over
        setData(result);
        setError(null);
        setHasLoaded(true);
        retryAttempt.current = 0;
        clearRetry();
      })
      .catch((err: unknown) => {
        if (id !== latest.current || ctrl.signal.aborted) return;
        const e =
          err instanceof DevNexusError
            ? err
            : new DevNexusError(0, 'unknown', (err as Error)?.message ?? 'Something went wrong.');
        setError(e);
        setHasLoaded(true);

        // Keep trying through a connection outage so the page heals itself.
        if (e.code === 'network' || e.code === 'timeout') {
          const n = retryAttempt.current++;
          const wait = Math.min(3000 * 2 ** n, 30_000);
          clearRetry();
          retryTimer.current = window.setTimeout(() => {
            if (!document.hidden) setNonce((v) => v + 1);
          }, wait);
        }
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });

    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  // Polling. Paused while the tab is hidden — a background tab refetching every
  // few seconds burns the account's Lambda concurrency for nobody's benefit.
  useEffect(() => {
    if (!enabled || !effectivePoll) return;
    let timer: number | null = null;

    const tick = () => {
      if (!document.hidden) setNonce((n) => n + 1);
    };
    const start = () => {
      if (timer === null) timer = window.setInterval(tick, effectivePoll);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        // Catch up immediately on return, then resume the interval.
        setNonce((n) => n + 1);
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, effectivePoll]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    error,
    loading,
    initialLoading: loading && !hasLoaded,
    refetch,
  };
}

/**
 * A one-shot action: submitting a form, promoting a strategy, answering an
 * approval. Tracks pending/error so a button can disable itself and a form can
 * show what went wrong, without every caller writing the same three useStates.
 */
export interface MutationState<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: DevNexusError | null;
  reset: () => void;
}

export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { onSuccess?: (result: R) => void; onError?: (err: DevNexusError) => void } = {},
): MutationState<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<DevNexusError | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      // Still call onSuccess after unmount: a navigation away is often the
      // success path, and the caller may need to update a store.
      optsRef.current.onSuccess?.(result);
      return result;
    } catch (err) {
      const e =
        err instanceof DevNexusError
          ? err
          : new DevNexusError(0, 'unknown', (err as Error)?.message ?? 'Something went wrong.');
      if (alive.current) setError(e);
      optsRef.current.onError?.(e);
      return undefined;
    } finally {
      if (alive.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
