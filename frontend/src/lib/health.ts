import type { SystemHealthResponse } from '@/api/types';

/**
 * Turn `/analytics/system` into the one verdict a dashboard needs.
 *
 * The endpoint deliberately does NOT return a single `healthy` boolean — it
 * reports latency, safety counters and data freshness separately, because what
 * counts as unhealthy is a product judgement rather than a server one. That
 * judgement is made here, once, so the dashboard and the analytics page cannot
 * disagree about whether the system is fine.
 *
 * The rules, in order of severity:
 *
 *  - a FALLBACK decision means the engine could not run and a safe price was
 *    served instead. That is the most serious state: pricing is not actually
 *    working, even though requests are succeeding.
 *  - STALE signals mean prices are being computed from old context. The engine
 *    is running, but on information that may no longer be true.
 *  - DEGRADED decisions are the milder form of the same problem and only count
 *    as a warning.
 *
 * With one exception that matters more than it sounds. `degraded` is set both
 * when a signal went stale AND when it was never sent, and a project that has
 * received no events yet trips the second case on every single decision. That
 * is not a degradation — it is a system working correctly on a project nobody
 * has fed yet. `data_freshness` is what tells them apart: no signals tracked at
 * all means nothing has ever arrived, so the verdict is WAITING, not warning.
 */
export type HealthVerdict = 'healthy' | 'waiting' | 'warning' | 'critical';

export interface Health {
  verdict: HealthVerdict;
  /** One sentence, written for an analyst rather than an operator. */
  summary: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  requests: number | null;
  /** True when the latency figures come from this process's own samples. */
  selfMeasured: boolean;
  caveat: string | null;
}

export function readHealth(data: SystemHealthResponse | null): Health {
  if (!data) {
    return {
      verdict: 'healthy',
      summary: 'Checking the pricing API…',
      p50: null,
      p95: null,
      p99: null,
      requests: null,
      selfMeasured: false,
      caveat: null,
    };
  }

  const api = data.pricing_api;
  const safety = data.pricing_safety;
  const fresh = data.data_freshness;

  const fallbacks = safety?.fallback_decisions ?? 0;
  const degraded = safety?.degraded_decisions ?? 0;
  const anyStale = fresh?.any_stale ?? false;
  // An empty freshness list means no signal has EVER been written for this
  // project — not that the ones it has are old.
  const neverFed = (fresh?.signals?.length ?? 0) === 0;

  let verdict: HealthVerdict = 'healthy';
  let summary = 'The pricing API is responding normally and running on fresh context.';

  if (fallbacks > 0) {
    // The only state that means pricing is genuinely not working.
    verdict = 'critical';
    summary =
      fallbacks === 1
        ? 'One decision fell back to a safe price because the engine could not run.'
        : `${fallbacks} decisions fell back to a safe price because the engine could not run.`;
  } else if (anyStale) {
    verdict = 'warning';
    const oldest = fresh.signals?.find((sig) => sig.stale)?.signal;
    summary = oldest
      ? `Prices are being computed from stale context — ${oldest} has not updated recently.`
      : 'Prices are being computed from stale context.';
  } else if (degraded > 0 && neverFed) {
    // Every decision lacked signals because none have ever been sent. Nothing
    // is broken; the project has not been connected to anything yet.
    verdict = 'waiting';
    summary =
      'No signals have arrived yet, so prices are the base price. Send your first ' +
      'events and the rules start applying.';
  } else if (degraded > 0) {
    verdict = 'warning';
    summary =
      degraded === 1
        ? 'One decision ran without every signal.'
        : `${degraded} decisions ran without every signal.`;
  }

  return {
    verdict,
    summary,
    p50: api?.self_measured?.p50_ms ?? null,
    p95: api?.self_measured?.p95_ms ?? null,
    p99: api?.self_measured?.p99_ms ?? null,
    requests: api?.requests_last_hour ?? null,
    selfMeasured: (api?.self_measured?.source ?? '') !== '',
    caveat: api?.self_measured?.caveat ?? null,
  };
}
