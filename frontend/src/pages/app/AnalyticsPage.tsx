import { useState } from 'react';
import { analyticsApi } from '@/api/endpoints';
import type { Metric as MetricName, TimeRange } from '@/api/endpoints';
import { TimeChart, type ChartKind, type ValueFormat } from '@/components/charts/TimeChart';
import { PageHeader, Row, Stack, TwoCol } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { HealthBadge } from '@/components/HealthBadge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Segmented } from '@/components/ui/Field';
import { Table, type Column } from '@/components/ui/Table';
import { useAsync } from '@/hooks/useAsync';
import { intervalFor, useRange } from '@/hooks/useRange';
import { useSession } from '@/hooks/useSession';
import type { RuleAnalyticsResponse } from '@/api/types';
import { money, ms, number, percent } from '@/lib/format';
import { readHealth } from '@/lib/health';

/**
 * Analytics.
 *
 * Grouped into three tabs rather than eleven charts on one page: the spec warns
 * against chart overload, and eleven simultaneous series is overload no matter
 * how well each one is drawn. Each chart also states the question it answers, so
 * a chart that answers nothing has nowhere to hide.
 *
 * Each tab fetches only its own series. Loading all eleven on arrival would be
 * eleven requests against a low concurrency ceiling for charts nobody is looking
 * at yet.
 */

interface ChartSpec {
  metric: MetricName;
  title: string;
  question: string;
  format: ValueFormat;
  kind?: ChartKind;
  colorVar?: string;
  emptyHint: string;
}

const TABS = [
  { value: 'pricing', label: 'Pricing' },
  { value: 'system', label: 'System' },
] as const;

type Tab = (typeof TABS)[number]['value'];

const CHARTS: Record<Tab, ChartSpec[]> = {
  pricing: [
    {
      metric: 'price',
      title: 'Average price',
      question: 'Where has pricing settled?',
      format: 'money',
      kind: 'line',
      emptyHint: 'No pricing decisions in this window yet.',
    },
    {
      metric: 'price_changes',
      title: 'Price changes',
      question: 'How often is pricing actually moving?',
      format: 'number',
      kind: 'bar',
      colorVar: '--chart-6',
      emptyHint: 'No decisions changed a price in this window.',
    },
  ],
  system: [
    {
      metric: 'api_requests',
      title: 'API requests',
      question: 'How much traffic is the pricing API serving?',
      format: 'number',
      kind: 'bar',
      colorVar: '--chart-2',
      emptyHint: 'No pricing API calls in this window.',
    },
    {
      metric: 'latency',
      title: 'Response time',
      question: 'Is the pricing API staying fast?',
      format: 'ms',
      kind: 'line',
      colorVar: '--chart-4',
      emptyHint: 'Latency appears once the pricing API has served requests.',
    },
    {
      metric: 'traffic',
      title: 'Traffic signal',
      question: 'How busy is the business right now?',
      format: 'number',
      colorVar: '--chart-5',
      emptyHint: 'Report view or traffic_update events to track this.',
    },
  ],
};

export default function AnalyticsPage() {
  const { project, projectId } = useSession();
  const { range, setRange, RANGE_OPTIONS } = useRange();
  const [tab, setTab] = useState<Tab>('pricing');

  const overview = useAsync(
    (signal) => analyticsApi.overview(projectId!, range, { signal }),
    [projectId, range],
    { enabled: !!projectId },
  );

  const rules = useAsync(
    (signal) => analyticsApi.rules(projectId!, range, { signal }),
    [projectId, range],
    { enabled: !!projectId && tab === 'pricing' },
  );

  const system = useAsync(
    (signal) => analyticsApi.system(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId && tab === 'system' },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="analytics"
          title="No project selected"
          body="Create a project to start collecting analytics."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const currency = overview.data?.currency ?? project.currency;
  const specs = CHARTS[tab];
  const health = readHealth(system.data);

  return (
    <Stack>
      <PageHeader
        title="Analytics"
        description="Every chart here answers one question. The range applies to all of them."
        actions={
          <Row>
            <Segmented label="Time range" value={range} options={RANGE_OPTIONS} onChange={setRange} />
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              aria-label="Refresh"
              onClick={() => {
                overview.refetch();
                rules.refetch();
                system.refetch();
              }}
            />
          </Row>
        }
      />

      {/* Each chart loads independently and shows its own state, so only the
          KPI strip is affected by this failing. */}
      {overview.error && (
        <ErrorState
          compact
          error={overview.error}
          title="Summary metrics are unavailable right now"
          onRetry={overview.refetch}
        />
      )}

      {overview.data?.kpis && (
        <MetricGrid>
          <Metric
            label="Average price"
            value={money(overview.data.kpis.avg_price.value, currency)}
            change={overview.data.kpis.avg_price.change_pct}
            changeIsGood
          />
          <Metric
            label="Decisions"
            value={number(overview.data.kpis.decisions.value)}
            change={overview.data.kpis.decisions.change_pct}
            changeIsGood
          />
          <Metric
            label="Change rate"
            value={percent(overview.data.kpis.price_changes.rate_pct)}
            foot="of decisions moved a price"
          />
        </MetricGrid>
      )}

      <Row>
        <Segmented label="Section" value={tab} options={TABS} onChange={setTab} />
        {overview.data?.note && <Badge tone="neutral">{overview.data.note}</Badge>}
      </Row>

      <TwoCol>
        {specs.map((spec) => (
          <ChartPanel
            key={spec.metric}
            spec={spec}
            projectId={projectId!}
            range={range}
            currency={currency}
          />
        ))}
      </TwoCol>

      {/* ── rule health, on the pricing tab ──────────────────────────────── */}
      {tab === 'pricing' && (
        <Card>
          <CardHeader
            title="Rule health"
            subtitle="Which rules are actually doing the work, and which never fire."
          />
          {rules.initialLoading ? (
            <Loading label="Measuring rule activity" />
          ) : rules.error ? (
            <CardBody>
              <ErrorState error={rules.error} onRetry={rules.refetch} />
            </CardBody>
          ) : (rules.data?.rules ?? []).length === 0 ? (
            <EmptyState
              icon="rules"
              title="No rule activity in this window"
              body="Rules record activity once decisions run against them. Send traffic or widen the time range."
              action={
                <LinkButton to="/app/rules" variant="secondary" size="sm">
                  Review your rules
                </LinkButton>
              }
            />
          ) : (
            <Table
              caption="Rule activity"
              columns={RULE_COLUMNS}
              rows={rules.data?.rules ?? []}
              rowKey={(r) => r.rule_id}
            />
          )}
        </Card>
      )}

      {/* ── latency detail, on the system tab ───────────────────────────── */}
      {tab === 'system' && (
        <Card>
          <CardHeader
            title="Pricing API"
            subtitle={health.summary}
            actions={
              system.data ? (
                <HealthBadge verdict={health.verdict} />
              ) : null
            }
          />
          <CardBody>
            {system.initialLoading ? (
              <Loading label="Reading system health" inline />
            ) : (
              <>
                <MetricGrid>
                  <Metric label="p50" value={ms(health.p50)} foot="typical request" />
                  <Metric label="p95" value={ms(health.p95)} foot="slowest 1 in 20" />
                  <Metric label="p99" value={ms(health.p99)} foot="slowest 1 in 100" />
                  <Metric
                    label="Requests"
                    value={number(health.requests)}
                    foot="in the last hour"
                  />
                </MetricGrid>
                {health.caveat && (
                  <p
                    style={{
                      marginTop: 'var(--s-4)',
                      fontSize: 'var(--t-xs)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {health.caveat}
                  </p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

/**
 * One chart, fetching its own series.
 *
 * Per-chart rather than one combined request because `/analytics/timeseries`
 * takes a single metric. Keeping the fetch inside the panel also means a metric
 * that fails or is empty degrades alone instead of blanking the page.
 */
function ChartPanel({
  spec,
  projectId,
  range,
  currency,
}: {
  spec: ChartSpec;
  projectId: string;
  range: TimeRange;
  currency: string;
}) {
  const series = useAsync(
    (signal) =>
      analyticsApi.timeseries(
        projectId,
        spec.metric,
        { range, interval: intervalFor(range) },
        { signal },
      ),
    [projectId, spec.metric, range],
  );

  return (
    <TimeChart
      title={spec.title}
      question={spec.question}
      data={series.data}
      loading={series.loading}
      kind={spec.kind}
      format={spec.format}
      currency={currency}
      colorVar={spec.colorVar}
      emptyHint={spec.emptyHint}
      // Every chart in a tab shares a cursor, so a spike can be traced across
      // revenue, orders and conversion at the same instant.
      syncId="analytics"
      // Only the long windows, where a point is an hour or a day and the detail
      // is unreadable without zooming in.
      brush={range === '7d' || range === '30d'}
    />
  );
}

type RuleRow = RuleAnalyticsResponse['rules'][number];

const RULE_COLUMNS: readonly Column<RuleRow>[] = [
  { key: 'name', header: 'Rule', render: (r) => r.name },
  { key: 'priority', header: 'Priority', align: 'num', render: (r) => number(r.priority) },
  { key: 'triggered', header: 'Triggered', align: 'num', render: (r) => number(r.triggered) },
  {
    key: 'suppressed',
    header: 'Suppressed',
    align: 'num',
    // Suppressed means the rule matched but lost to a higher-priority rule in
    // its conflict group. High suppression is the signal that a rule is
    // configured but effectively unreachable.
    render: (r) =>
      r.suppressed > 0 ? (
        <span style={{ color: 'var(--warning-text)' }}>{number(r.suppressed)}</span>
      ) : (
        number(0)
      ),
  },
  {
    key: 'impact',
    header: 'Total impact',
    align: 'num',
    render: (r) => (
      <span
        style={{
          color:
            r.total_impact > 0
              ? 'var(--success-text)'
              : r.total_impact < 0
                ? 'var(--critical-text)'
                : undefined,
        }}
      >
        {r.total_impact === 0 ? '—' : money(r.total_impact, null, { compact: true })}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) =>
      r.never_fired ? (
        // Not an error, but worth noticing: usually the condition is
        // unreachable, or the signal it reads never arrives.
        <Badge tone="warning">Never fired</Badge>
      ) : r.suppressed > r.triggered ? (
        <Badge tone="info">Mostly suppressed</Badge>
      ) : (
        <Badge tone="success">Active</Badge>
      ),
  },
];
