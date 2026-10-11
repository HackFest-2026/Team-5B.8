import { useEffect, useState } from 'react';
import {
  backtestApi,
  itemsApi,
  projectsApi,
  simulateApi,
  strategiesApi,
} from '@/api/endpoints';
import type { BacktestResultResponse, WhatIfResponse } from '@/api/types';
import { KeyValues, Note, PageHeader, Row, Stack, TwoCol, Well } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { Input, Segmented, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading, Progress } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { dateTime, isoDate, money, number, percent, plural } from '@/lib/format';

/**
 * Simulation: what-if, backtest and shadow comparison.
 *
 * Three tabs because they answer three different questions, and mixing them
 * would obscure which one the user is looking at:
 *
 *   what-if  — "what would this strategy charge under conditions I invent?"
 *   backtest — "what would it have earned over my real history?"
 *   shadow   — "what is it quietly deciding right now, against what we charge?"
 *
 * None of these touches live pricing. That is stated on screen, because the
 * whole point of this page is to be safe to experiment on.
 */

const TABS = [
  { value: 'whatif', label: 'What-if' },
  { value: 'backtest', label: 'Backtest' },
  { value: 'shadow', label: 'Shadow' },
] as const;

type Tab = (typeof TABS)[number]['value'];

export default function SimulationPage() {
  const { project, projectId } = useSession();
  const [tab, setTab] = useState<Tab>('whatif');

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="simulation"
          title="No project selected"
          body="Create a project before testing a pricing strategy."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  return (
    <Stack>
      <PageHeader
        title="Simulation"
        description="Test a strategy against invented conditions, against your own history, or against live traffic without customers seeing it. Nothing here changes what you charge."
        actions={<Segmented label="Mode" value={tab} options={TABS} onChange={setTab} />}
      />

      {tab === 'whatif' && <WhatIfTab projectId={projectId!} />}
      {tab === 'backtest' && <BacktestTab projectId={projectId!} />}
      {tab === 'shadow' && <ShadowTab projectId={projectId!} />}
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   What-if
   ═══════════════════════════════════════════════════════════════════════ */

function WhatIfTab({ projectId }: { projectId: string }) {
  const [itemId, setItemId] = useState('');
  /**
   * Which strategy to simulate. Empty means "whatever is currently active".
   *
   * This selector is the whole point of the fix: `/simulate/whatif` evaluates
   * any version you name and treats it as live FOR THE SIMULATION ONLY. Without
   * passing `strategy_id` the endpoint falls back to the active strategy, so a
   * project whose candidate is still in draft or shadow could not be tested at
   * all — it answered "no active strategy" instead.
   */
  const [strategyRef, setStrategyRef] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WhatIfResponse | null>(null);

  const items = useAsync((signal) => itemsApi.list(projectId, { limit: 50 }, { signal }), [projectId]);
  const detail = useAsync((signal) => projectsApi.get(projectId, { signal }), [projectId]);
  const strategies = useAsync(
    (signal) => strategiesApi.list(projectId, { signal }),
    [projectId],
  );

  // Default to the first item so the form is usable immediately rather than
  // presenting an empty select the user has to notice.
  useEffect(() => {
    const first = items.data?.items?.[0]?.item_id;
    if (first && !itemId) setItemId(first);
  }, [items.data, itemId]);

  const signals = detail.data?.schema?.context_signals ?? [];

  /**
   * Every strategy version, newest first, labelled with its lifecycle state.
   *
   * Versions are deduped because the list is append-only — a rollback puts an
   * earlier version back on the end, so the raw array repeats entries.
   */
  const strategyOptions = (strategies.data?.strategies ?? []).flatMap((st) =>
    [...new Set(st.versions)].reverse().map((v) => ({
      value: `${st.strategy_id}::${v}`,
      label: `${st.name} ${v}${v === st.version ? ` · ${st.mode}` : ''}`,
    })),
  );

  const run = useMutation(
    () => {
      const [strategy_id, version] = strategyRef ? strategyRef.split('::') : [undefined, undefined];
      return simulateApi.whatIf({
        project_id: projectId,
        item_id: itemId,
        strategy_id,
        version,
        overrides: Object.fromEntries(
          Object.entries(overrides)
            .filter(([, v]) => v !== '')
            .map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]),
        ),
      });
    },
    { onSuccess: setResult },
  );

  if (items.initialLoading) return <Loading label="Loading items" />;

  if ((items.data?.items ?? []).length === 0) {
    return (
      <Card>
        <EmptyState
          icon="projects"
          title="No items to price"
          body="A what-if needs something to price. Add an item — a room, a product, a route — and come back."
          action={
            <LinkButton to="/app/items" variant="primary" icon="plus">
              Add an item
            </LinkButton>
          }
        />
      </Card>
    );
  }

  return (
    <TwoCol>
      <Card>
        <CardHeader
          title="Set the scenario"
          subtitle="Change any signal to a value you want to test. Anything you leave blank keeps its current value."
        />
        <CardBody>
          <Stack>
            <Select
              label="Strategy to test"
              value={strategyRef}
              placeholder="Whatever is active right now"
              options={strategyOptions}
              hint="You can test a draft or shadow strategy here. Simulating it does not make it live."
              onChange={(e) => setStrategyRef(e.target.value)}
            />

            <Select
              label="Item"
              value={itemId}
              options={(items.data?.items ?? []).map((i) => ({
                value: i.item_id,
                label: `${i.name} (${i.item_id})`,
              }))}
              onChange={(e) => setItemId(e.target.value)}
            />

            {signals.length === 0 ? (
              <Note>
                This project has no context signals defined yet, so there is nothing to vary. Add
                signals to the domain schema first.
              </Note>
            ) : (
              <Stack tight>
                {signals.map((sig) => (
                  <Input
                    key={sig.id}
                    label={sig.label}
                    type="number"
                    optional
                    value={overrides[sig.id] ?? ''}
                    placeholder={
                      sig.min !== undefined && sig.max !== undefined
                        ? `${sig.min} – ${sig.max}`
                        : 'current value'
                    }
                    hint={sig.description || undefined}
                    onChange={(e) =>
                      setOverrides((prev) => ({ ...prev, [sig.id]: e.target.value }))
                    }
                  />
                ))}
              </Stack>
            )}

            <Row>
              <Button
                variant="primary"
                icon="simulation"
                loading={run.pending}
                disabled={!itemId}
                onClick={() => void run.run()}
              >
                Run what-if
              </Button>
              <Button variant="ghost" onClick={() => setOverrides({})}>
                Reset
              </Button>
            </Row>

            {run.error && <ErrorState error={run.error} title="Could not run the simulation" />}
          </Stack>
        </CardBody>
      </Card>

      <Stack>
        {!result ? (
          <Card>
            <EmptyState
              icon="simulation"
              title="No simulation yet"
              body="Set a scenario and run it. You will see what the strategy would charge, which rules fired, and whether any guardrail clamped the result."
              compact
            />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title="Result"
                subtitle={`${result.item_id} · strategy ${result.strategy.version}`}
                actions={
                  result.difference.amount === 0 ? (
                    <Badge tone="neutral">No change</Badge>
                  ) : (
                    <Badge tone={result.difference.amount > 0 ? 'success' : 'warning'}>
                      {percent(result.difference.percent, { signed: true })}
                    </Badge>
                  )
                }
              />
              <CardBody>
                <MetricGrid>
                  <Metric
                    label="Currently"
                    value={money(result.current.price, result.currency)}
                    foot={
                      result.current.rules_fired.length > 0
                        ? result.current.rules_fired.join(', ')
                        : 'no rules firing'
                    }
                  />
                  <Metric
                    label="In this scenario"
                    value={money(result.simulated.price, result.currency)}
                    foot={
                      result.simulated.rules_fired.length > 0
                        ? result.simulated.rules_fired.join(', ')
                        : 'no rules firing'
                    }
                  />
                  <Metric
                    label="Difference"
                    value={money(result.difference.amount, result.currency)}
                    change={result.difference.percent}
                    changeIsGood
                  />
                </MetricGrid>

                {result.simulated.recommended_before_guardrails !== result.simulated.price && (
                  <Well>
                    <Row>
                      <Icon name="shield" size={15} style={{ color: 'var(--warning-text)' }} />
                      <strong style={{ fontSize: 'var(--t-sm)' }}>A guardrail changed this</strong>
                    </Row>
                    <p
                      style={{
                        marginTop: 'var(--s-2)',
                        fontSize: 'var(--t-sm)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      The rules asked for{' '}
                      {money(result.simulated.recommended_before_guardrails, result.currency)}; the
                      guardrails brought it to{' '}
                      <strong>{money(result.simulated.price, result.currency)}</strong>.
                    </p>
                  </Well>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Why" subtitle={result.simulated.explanation} />
              <CardBody>
                <Stack tight>
                  {result.simulated.drivers.map((d) => (
                    <div
                      key={`${d.rule_id}-${d.factor}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 'var(--s-3)',
                        fontSize: 'var(--t-sm)',
                      }}
                    >
                      <span>{d.factor}</span>
                      <span
                        className="num"
                        style={{
                          fontWeight: 500,
                          color: d.amount > 0 ? 'var(--success-text)' : 'var(--critical-text)',
                        }}
                      >
                        {d.impact}
                      </span>
                    </div>
                  ))}

                  {result.difference.newly_triggered.length > 0 && (
                    <Note>
                      <strong>Newly triggered:</strong>{' '}
                      {result.difference.newly_triggered.join(', ')}
                    </Note>
                  )}
                  {result.difference.no_longer_triggered.length > 0 && (
                    <Note>
                      <strong>No longer triggered:</strong>{' '}
                      {result.difference.no_longer_triggered.join(', ')}
                    </Note>
                  )}
                </Stack>
              </CardBody>
            </Card>

            {result.note && (
              <Card pad="sm">
                <Note>{result.note}</Note>
              </Card>
            )}
          </>
        )}
      </Stack>
    </TwoCol>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Backtest
   ═══════════════════════════════════════════════════════════════════════ */

function BacktestTab({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [strategyId, setStrategyId] = useState('');
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [watching, setWatching] = useState<string | null>(null);

  const strategies = useAsync((signal) => strategiesApi.list(projectId, { signal }), [projectId]);
  const history = useAsync(
    (signal) => backtestApi.list(projectId, 10, { signal }),
    [projectId, watching],
  );

  useEffect(() => {
    const first = strategies.data?.strategies?.[0]?.strategy_id;
    if (first && !strategyId) setStrategyId(first);
  }, [strategies.data, strategyId]);

  const start = useMutation(
    () =>
      backtestApi.run({
        project_id: projectId,
        strategy_id: strategyId,
        date_from: from,
        date_to: to,
      }),
    {
      onSuccess: (r) => {
        setWatching(r.job_id);
        toast.info('Backtest queued', 'Replaying your history. This usually takes a few seconds.');
      },
    },
  );

  /**
   * Poll the job while it runs.
   *
   * The backtest is queued to a worker, so the result is not available when
   * `/backtest/run` returns. Polling stops as soon as the status is terminal —
   * polling a finished job forever would be a slow leak against the concurrency
   * limit.
   */
  const result = useAsync(
    (signal) => backtestApi.result(projectId, watching!, { signal }),
    [projectId, watching],
    { enabled: !!watching, pollMs: 2500 },
  );

  const status = result.data?.status;
  const settled = status === 'completed' || status === 'failed';

  useEffect(() => {
    if (settled && watching) {
      history.refetch();
      if (status === 'completed') toast.success('Backtest complete');
      if (status === 'failed') toast.error('Backtest failed', 'The job could not be completed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, status]);

  const running = !!watching && !settled;

  return (
    <TwoCol>
      <Stack>
        <Card>
          <CardHeader
            title="Replay a strategy over your history"
            subtitle="DevNexus re-prices every decision in the window using the strategy you pick, then compares the outcome to what actually happened."
          />
          <CardBody>
            <Stack>
              {(strategies.data?.strategies ?? []).length === 0 ? (
                <EmptyState
                  compact
                  icon="strategies"
                  title="No strategy to test"
                  body="Create a strategy first, then backtest it against your historical data."
                  action={
                    <LinkButton to="/app/strategies" variant="primary" size="sm">
                      Go to strategies
                    </LinkButton>
                  }
                />
              ) : (
                <>
                  <Select
                    label="Strategy"
                    value={strategyId}
                    options={(strategies.data?.strategies ?? []).map((st) => ({
                      value: st.strategy_id,
                      label: `${st.name} (${st.version})`,
                    }))}
                    onChange={(e) => setStrategyId(e.target.value)}
                  />
                  <Row>
                    <Input
                      label="From"
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                    <Input
                      label="To"
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </Row>
                  <Note>
                    A backtest needs historical decisions or uploaded data in this window. If the
                    result says nothing was checked, widen the dates or upload more history.
                  </Note>
                  <Row>
                    <Button
                      variant="primary"
                      icon="play"
                      loading={start.pending || running}
                      disabled={!strategyId}
                      onClick={() => void start.run()}
                    >
                      {running ? 'Running…' : 'Run backtest'}
                    </Button>
                    <LinkButton to="/app/data" variant="ghost" icon="upload">
                      Upload history
                    </LinkButton>
                  </Row>
                  {start.error && (
                    <ErrorState error={start.error} title="Could not start the backtest" />
                  )}
                </>
              )}
            </Stack>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recent backtests" />
          <CardBody tight>
            {(history.data?.backtests ?? []).length === 0 ? (
              <EmptyState
                compact
                icon="analytics"
                title="No backtests yet"
                body="Run one above to see how a strategy would have performed."
              />
            ) : (
              <Stack tight>
                {(history.data?.backtests ?? []).map((b) => (
                  <button
                    key={b.job_id}
                    type="button"
                    onClick={() => setWatching(b.job_id)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--s-3)',
                      padding: 'var(--s-3)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r-md)',
                      background:
                        watching === b.job_id ? 'var(--accent-muted)' : 'var(--surface-sunken)',
                      textAlign: 'left',
                      fontSize: 'var(--t-sm)',
                    }}
                  >
                    <span>
                      {b.version}
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--t-xs)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {b.window.from} → {b.window.to}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Badge
                        tone={
                          b.status === 'completed'
                            ? 'success'
                            : b.status === 'failed'
                              ? 'critical'
                              : 'warning'
                        }
                      >
                        {b.status}
                      </Badge>
                      {b.revenue_uplift_pct !== null && (
                        <span
                          className="num"
                          style={{
                            display: 'block',
                            fontSize: 'var(--t-xs)',
                            marginTop: 2,
                            color:
                              b.revenue_uplift_pct > 0
                                ? 'var(--success-text)'
                                : 'var(--critical-text)',
                          }}
                        >
                          {percent(b.revenue_uplift_pct, { signed: true })}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </Stack>
            )}
          </CardBody>
        </Card>
      </Stack>

      <div>
        {!watching ? (
          <Card>
            <EmptyState
              icon="analytics"
              title="No result selected"
              body="Run a backtest, or pick one from the history, to see what it would have earned."
              compact
            />
          </Card>
        ) : running ? (
          <Card>
            <CardHeader title="Running historical simulation…" />
            <CardBody>
              <Progress value={60} label="Replaying your decisions against the strategy" />
              <div style={{ marginTop: 'var(--s-4)' }}>
                <Note>
                  This replays every stored decision in the window. It usually finishes in a few
                  seconds.
                </Note>
              </div>
            </CardBody>
          </Card>
        ) : result.error ? (
          <ErrorState error={result.error} onRetry={result.refetch} />
        ) : result.data ? (
          <BacktestReport report={result.data} />
        ) : null}
      </div>
    </TwoCol>
  );
}

function BacktestReport({ report }: { report: BacktestResultResponse }) {
  const c = report.comparison;
  const correctness = report.pricing_correctness;

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Backtest result"
          subtitle={`${report.version} · ${report.window.from} → ${report.window.to}`}
          actions={
            <Badge tone={report.status === 'completed' ? 'success' : 'critical'}>
              {report.status}
            </Badge>
          }
        />
        <CardBody>
          <MetricGrid>
            <Metric
              label="Revenue"
              value={money(c.revenue.simulated, report.currency, { compact: true })}
              change={c.revenue.uplift_pct}
              changeIsGood
              foot={`actually ${money(c.revenue.actual, report.currency, { compact: true })}`}
            />
            <Metric
              label="Margin"
              value={money(c.margin.simulated, report.currency, { compact: true })}
              change={c.margin.uplift_pct}
              changeIsGood
              foot={`actually ${money(c.margin.actual, report.currency, { compact: true })}`}
            />
            <Metric
              label="Average price"
              value={money(c.avg_price.simulated, report.currency)}
              change={c.avg_price.uplift_pct}
              changeIsGood
              foot={`actually ${money(c.avg_price.actual, report.currency)}`}
            />
            <Metric
              label="Orders"
              value={number(c.orders.simulated)}
              change={c.orders.uplift_pct}
              changeIsGood
              foot={`actually ${number(c.orders.actual)}`}
            />
          </MetricGrid>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What it did" />
        <CardBody>
          <KeyValues
            rows={[
              { key: 'Decisions replayed', value: number(report.activity.decisions_replayed) },
              { key: 'Prices changed', value: number(report.activity.price_changes) },
              { key: 'Guardrail blocks', value: number(report.activity.guardrail_blocks) },
              { key: 'Items covered', value: number(report.activity.items_covered) },
            ]}
          />

          {Object.keys(report.rules_triggered).length > 0 && (
            <div style={{ marginTop: 'var(--s-4)' }}>
              <strong style={{ fontSize: 'var(--t-sm)' }}>Rules triggered</strong>
              <div style={{ marginTop: 'var(--s-2)' }}>
                <KeyValues
                  rows={Object.entries(report.rules_triggered).map(([k, v]) => ({
                    key: k,
                    value: `${number(v)} times`,
                  }))}
                />
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Reproducibility is reported honestly, including the case where there was
          nothing in the window to reproduce — which is not the same as a pass. */}
      <Card>
        <CardHeader
          title="Reproducibility"
          actions={
            correctness.checked === 0 ? (
              <Badge tone="neutral">Nothing to check</Badge>
            ) : correctness.deterministic ? (
              <Badge tone="success" icon="check">
                Verified
              </Badge>
            ) : (
              <Badge tone="critical" icon="warning">
                Mismatch
              </Badge>
            )
          }
        />
        <CardBody>
          {correctness.checked === 0 ? (
            <Note>
              No stored decisions fell inside this window, so there was nothing to re-verify. Widen
              the dates, or upload historical data, to get a reproducibility check.
            </Note>
          ) : (
            <KeyValues
              rows={[
                { key: 'Decisions checked', value: number(correctness.checked) },
                { key: 'Reproduced exactly', value: number(correctness.reproduced) },
              ]}
            />
          )}
          {correctness.note && (
            <p
              style={{
                marginTop: 'var(--s-3)',
                fontSize: 'var(--t-xs)',
                color: 'var(--text-muted)',
              }}
            >
              {correctness.note}
            </p>
          )}
        </CardBody>
      </Card>

      {report.assumptions && (
        <Card pad="sm">
          <Row>
            <Icon name="info" size={15} style={{ color: 'var(--info-text)' }} />
            <strong style={{ fontSize: 'var(--t-sm)' }}>Assumptions</strong>
          </Row>
          <p
            style={{
              marginTop: 'var(--s-2)',
              fontSize: 'var(--t-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {report.assumptions.note}
          </p>
          <p
            style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}
          >
            Price elasticity assumed: {report.assumptions.price_elasticity}. Treat the revenue
            figures as directional, not as a forecast.
          </p>
        </Card>
      )}

      <p style={{ fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
        Completed {dateTime(report.completed_at)}
      </p>
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Shadow
   ═══════════════════════════════════════════════════════════════════════ */

function ShadowTab({ projectId }: { projectId: string }) {
  const comparison = useAsync(
    (signal) => backtestApi.shadowComparison(projectId, 50, { signal }),
    [projectId],
    { pollMs: 30_000 },
  );

  const data = comparison.data;

  if (comparison.initialLoading) return <Loading label="Loading shadow comparison" />;
  if (comparison.error) return <ErrorState error={comparison.error} onRetry={comparison.refetch} />;

  if (!data?.shadow_active) {
    return (
      <Card>
        <EmptyState
          icon="strategies"
          title="No strategy running in shadow"
          body={
            data?.message ??
            'Shadow mode runs a candidate strategy against real traffic while customers keep seeing the current price. Promote a validated strategy to shadow to see what it would decide.'
          }
          action={
            <LinkButton to="/app/strategies" variant="primary">
              Go to strategies
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const summary = data.summary;

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Shadow comparison"
          subtitle={
            data.shadow_strategy
              ? `${data.shadow_strategy.version} · shadowing since ${dateTime(
                  data.shadow_strategy.since,
                )}`
              : undefined
          }
          actions={
            <Badge tone="info" icon="live">
              {plural(data.sample_size ?? 0, 'decision')} compared
            </Badge>
          }
        />
        <CardBody>
          {summary ? (
            <MetricGrid>
              <Metric
                label="Average difference"
                value={percent(summary.avg_difference_pct, { signed: true })}
                foot="shadow versus live"
              />
              <Metric label="Would price higher" value={number(summary.would_price_higher)} />
              <Metric label="Would price lower" value={number(summary.would_price_lower)} />
              <Metric label="Would match" value={number(summary.would_match)} />
            </MetricGrid>
          ) : (
            <Note>
              No decisions have been compared yet. The shadow strategy evaluates alongside every
              live request, so figures appear as traffic arrives.
            </Note>
          )}
        </CardBody>
      </Card>

      {data.customer_impact && (
        <Card tone="accent" pad="md">
          <Row>
            <Icon name="shield" size={16} style={{ color: 'var(--accent)' }} />
            <strong style={{ fontSize: 'var(--t-sm)' }}>Customer impact</strong>
          </Row>
          <p
            style={{
              marginTop: 'var(--s-2)',
              fontSize: 'var(--t-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {data.customer_impact}
          </p>
        </Card>
      )}
    </Stack>
  );
}
