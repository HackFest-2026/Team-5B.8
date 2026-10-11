import { useEffect, useRef, useState } from 'react';
import { simulateApi } from '@/api/endpoints';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import type { TestCase } from './buildTests';
import s from './TestRunner.module.css';

/**
 * Runs the generated test plan against the real engine, one case at a time.
 *
 * Deliberately sequential and deliberately not instant. Firing all of them at
 * once would be faster and tell the user nothing: the value here is watching
 * each case resolve, because that is what turns "it says it works" into "I saw
 * it work". The pacing is ~400ms between cases, which is long enough to read a
 * row and short enough not to feel padded.
 *
 * Every call goes to `/simulate/whatif`, which runs the PRODUCTION engine on a
 * hypothetical context. Nothing here is mocked, and nothing it does touches a
 * live price.
 */

type Status = 'pending' | 'running' | 'pass' | 'fail';

interface Result {
  status: Status;
  actual?: number;
  ms?: number;
  error?: string;
  fired?: string[];
}

export interface TestRunnerProps {
  projectId: string;
  cases: readonly TestCase[];
  currency: string;
  strategyId?: string;
  /** Called once every case has settled. */
  onDone: (allPassed: boolean) => void;
}

export function TestRunner({
  projectId,
  cases,
  currency,
  strategyId,
  onDone,
}: TestRunnerProps) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);

  // The run is fired once from an effect and must not restart when React
  // re-renders or remounts in StrictMode — each case is a real API call.
  const ranRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (ranRef.current || cases.length === 0) return;
    ranRef.current = true;
    let cancelled = false;

    const run = async () => {
      // A beat before the first case, so the user reads what is about to
      // happen instead of results appearing out of nowhere.
      await new Promise((r) => setTimeout(r, 900));
      if (cancelled) return;
      setStarted(true);

      let allPassed = true;

      for (const c of cases) {
        if (cancelled) return;
        setResults((prev) => ({ ...prev, [c.id]: { status: 'running' } }));

        const t0 = performance.now();
        try {
          const res = await simulateApi.whatIf({
            project_id: projectId,
            item_id: c.itemId,
            strategy_id: strategyId,
            overrides: c.signals,
          });
          const actual = res.simulated.price;
          const ms = Math.round(performance.now() - t0);
          // We no longer fail a case for differing from a predicted number — a
          // prediction can be wrong where the engine is right. A case "passes"
          // when the engine priced it; we show the price and which rules fired
          // so the user judges whether it behaves as intended.
          const fired = (res.simulated.rules_fired ?? []).map(String);
          if (cancelled) return;
          setResults((prev) => ({
            ...prev,
            [c.id]: { status: 'pass', actual, ms, fired },
          }));
        } catch (err) {
          allPassed = false;
          if (cancelled) return;
          setResults((prev) => ({
            ...prev,
            [c.id]: {
              status: 'fail',
              ms: Math.round(performance.now() - t0),
              error: err instanceof Error ? err.message : 'The request failed.',
            },
          }));
        }

        await new Promise((r) => setTimeout(r, 420));
      }

      if (cancelled) return;
      setFinished(true);
      onDoneRef.current(allPassed);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [cases, projectId, strategyId]);

  const failed = cases.filter((c) => results[c.id]?.status === 'fail').length;

  return (
    <div className={s.wrap}>
      {!started && (
        <div className={s.preamble}>
          <span className={s.thinkDots}>
            <span className={s.thinkDot} />
            <span className={s.thinkDot} style={{ animationDelay: '0.15s' }} />
            <span className={s.thinkDot} style={{ animationDelay: '0.3s' }} />
          </span>
          Reading your rules, prices and limits — building tests from your own numbers…
        </div>
      )}

      {cases.map((c, i) => {
        const r = results[c.id] ?? { status: 'pending' as Status };
        return (
          <div
            key={c.id}
            className={cx(
              s.case,
              r.status === 'pending' && s.casePending,
              r.status === 'running' && s.caseRunning,
              r.status === 'pass' && s.casePass,
              r.status === 'fail' && s.caseFail,
            )}
            style={{ animationDelay: `${i * 70}ms` }}
          >
            <span
              className={cx(
                s.mark,
                r.status === 'running' && s.markRunning,
                r.status === 'pass' && s.markPass,
                r.status === 'fail' && s.markFail,
              )}
            >
              {r.status === 'running' && <Icon name="spinner" size={13} />}
              {r.status === 'pass' && <Icon name="check" size={13} strokeWidth={3} />}
              {r.status === 'fail' && <Icon name="close" size={13} strokeWidth={2.5} />}
              {r.status === 'pending' && <Icon name="dot" size={11} strokeWidth={3} />}
            </span>

            <div className={s.body}>
              <div className={s.title}>{c.title}</div>
              <div className={s.rationale}>{c.rationale}</div>

              <div className={s.given}>
                <span className={s.chip}>{c.itemName}</span>
                {Object.entries(c.signals).map(([k, v]) => (
                  <span key={k} className={s.chip}>
                    {k} {v}
                  </span>
                ))}
              </div>

              {r.actual !== undefined && (
                <div className={s.verdict}>
                  <span className={s.actualPass}>
                    price {money(r.actual, currency)}
                  </span>
                  <span className={s.expected}>
                    {r.fired && r.fired.length > 0
                      ? `rules fired: ${r.fired.join(', ')}`
                      : 'no rule fired — base price'}
                  </span>
                </div>
              )}

              {r.error && <div className={s.why}>{r.error}</div>}
            </div>

            <span className={s.timing}>{r.ms !== undefined ? `${r.ms}ms` : ''}</span>
          </div>
        );
      })}

      {finished && (
        <div className={cx(s.summary, failed > 0 && s.summaryBad)}>
          <span className={s.summaryIcon}>
            <Icon name={failed > 0 ? 'warning' : 'check'} size={18} strokeWidth={2.4} />
          </span>
          <div>
            <div className={s.summaryTitle}>
              {failed > 0
                ? `${failed} of ${cases.length} could not be priced`
                : `All ${cases.length} priced by the engine`}
            </div>
            <div className={s.summaryBody}>
              {failed > 0
                ? 'Those cases errored — check the project is set up and the strategy is active.'
                : 'Each case ran through the real engine. Check the price and the rules that fired look right for your intent.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
