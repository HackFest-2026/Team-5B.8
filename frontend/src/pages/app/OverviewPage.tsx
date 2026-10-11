import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyticsApi, liveApi, strategiesApi } from '@/api/endpoints';
import { TimeChart } from '@/components/charts/TimeChart';
import { MainWithSide, PageHeader, Row, Spread, Stack } from '@/components/PageHeader';
import { Badge, LiveIndicator, ModeBadge } from '@/components/ui/Badge';
import { HealthBadge } from '@/components/HealthBadge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/Feedback';
import { Segmented } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { useApprovals } from '@/hooks/useApprovals';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useLive, useResync } from '@/hooks/useLive';
import { useSession } from '@/hooks/useSession';
import { useRange } from '@/hooks/useRange';
import { money, ms, number, percent, plural, relativeTime } from '@/lib/format';
import { cx } from '@/lib/cx';
import { readHealth } from '@/lib/health';
import shell from './ProjectDashboard.module.css';
import { DecisionsSection } from './DecisionsPage';
import { LiveSection } from './LivePage';
import { PendingDecision } from './parts/PendingDecision';

/**
 * The project dashboard: everything this project is doing, in one place.
 *
 * Overview, Live and Decisions used to be three nav items answering one
 * question — "what is this project doing right now" — so they are one screen.
 * The summary is always visible; the evidence behind it sits in tabs below,
 * because evidence nobody can find is evidence nobody checks.
 *
 * It exists to answer one question on arrival: is my pricing system healthy?
 * So the order is deliberate — status first, then the KPIs, then safety, then
 * what is happening right now. Charts come after, because a chart answers
 * "how has it been", which is the second question, not the first.
 *
 * Six KPI cards, not twenty. The spec is explicit, and more than six means none
 * of them is being read.
 */
export default function ProjectDashboardPage() {
  const { project, projects, tenant } = useSession();
  const { state: liveState } = useLive();
  const navigate = useNavigate();
  const { range, setRange, RANGE_OPTIONS } = useRange();
  const [tab, setTab] = useState<'live' | 'decisions'>('live');

  const projectId = project?.project_id ?? null;

  const overview = useAsync(
    (signal) => analyticsApi.overview(projectId!, range, { signal }),
    [projectId, range],
    { enabled: !!projectId, pollMs: 60_000 },
  );

  const pulse = useAsync(
    (signal) => liveApi.pulse(projectId!, { events: 8, decisions: 6 }, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 20_000 },
  );

  const system = useAsync(
    (signal) => analyticsApi.system(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 120_000 },
  );

  const priceSeries = useAsync(
    (signal) => analyticsApi.timeseries(projectId!, 'price', { range }, { signal }),
    [projectId, range],
    { enabled: !!projectId },
  );


  // The socket carries no backlog, so after a reconnect the only correct move is
  // to re-read the authoritative state rather than trusting what is on screen.
  // Shared with the top-bar bell and the alerts page: one fetch, three readers.
  const pending = useApprovals();

  /**
   * State for the setup checklist.
   *
   * Gated on the project not already being active: once it is live the checklist
   * is hidden, so fetching rules, strategies and backtests for it would be three
   * requests per dashboard load for something nobody sees.
   */
  useResync(() => {
    pulse.refetch();
    overview.refetch();
  });

  /* ── no project yet ──────────────────────────────────────────────────── */
  if (projects.length === 0) {
    return (
      <>
        <PageHeader
          title={`Welcome, ${tenant?.company_name ?? 'there'}`}
          description="A project is one pricing surface — its own schema, items, rules, strategies and API key. Create your first one to get started."
        />
        <Card>
          <EmptyState
            icon="projects"
            title="No projects yet"
            body="Create a project to define what you price, how you price it, and the limits it must stay inside. You can have as many as you need, and they stay completely separate."
            action={
              <LinkButton to="/app/projects/new" variant="primary" icon="plus">
                Create your first project
              </LinkButton>
            }
          />
        </Card>
      </>
    );
  }

  if (!project) return null;

  const kpis = overview.data?.kpis;
  const safety = overview.data?.safety;
  const currency = overview.data?.currency ?? project.currency;
  const status = pulse.data?.status;
  const counters = pulse.data?.counters;

  const isLive = status?.live ?? project.mode === 'active';
  const pendingItems = pending.approvals.slice(0, 3);
  // `/analytics/system` reports components, not a verdict. `readHealth` makes the
  // judgement in one place so this page and the analytics page always agree.
  const health = readHealth(system.data);
  // A shadow run only counts when it is a different strategy from the live one.
  const shadowIsReal =
    !!status?.shadow_version &&
    (!status.shadow_strategy_id || status.shadow_strategy_id !== status.active_strategy_id);

  return (
    <Stack>
      <PageHeader
        title={project.name}
        badge={<ModeBadge mode={status?.mode ?? project.mode} />}
        description={
          isLive
            ? 'This project is serving live prices. Everything below is real traffic.'
            : 'Pricing is switched off, so the price endpoint is not answering. Turn it on from the switch in the top bar when you are ready.'
        }
        actions={
          <Row>
            <Segmented
              label="Time range"
              value={range}
              options={RANGE_OPTIONS}
              onChange={setRange}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              onClick={() => {
                overview.refetch();
                pulse.refetch();
              }}
              aria-label="Refresh"
            />
          </Row>
        }
      />

      {/* A pricing change waiting to be published is the first thing the owner
          needs to see and act on. */}
      {projectId && <PublishApprovalBanner projectId={projectId} onResolved={() => { pulse.refetch(); overview.refetch(); }} />}

      {/* A decision waiting on a human is the most important thing on the page,
          so it sits above the metrics rather than in a notification tray. */}
      {pendingItems.length > 0 && (
        <PendingDecision
          approvals={pendingItems}
          onAnswered={() => {
            pending.refetch();
            pulse.refetch();
            overview.refetch();
          }}
        />
      )}

      {/* The DLQ panel used to sit here. It was removed because SQS dead-letter
          queues are DEPLOYMENT-WIDE, not per project: a brand-new project was
          being told that 12 of its jobs had failed and that it should re-upload
          a file it had never uploaded. The number is real, but it does not
          belong to any one project, so it stays on the pipeline screen where it
          is labelled as infrastructure. */}

      {/* ── is it healthy? ─────────────────────────────────────────────── */}
      <Card pad="none">
        <div className={shell.facts}>
          <div className={shell.factList}>
            <StatusFact
              label="Strategy"
              value={
                status?.active_strategy_id ? (
                  <>
                    {status.active_version}{' '}
                    {/* Only a genuine shadow run: a DIFFERENT strategy evaluating
                        alongside the live one. A strategy shadowing itself is
                        not a comparison, and rendering it produced the
                        nonsensical "v1  SHADOW v1". The server already filters
                        this; checking here too means a stale cached response
                        cannot reintroduce it. */}
                    {shadowIsReal && (
                      <Badge tone="info" caps>
                        shadow {status.shadow_version}
                      </Badge>
                    )}
                  </>
                ) : (
                  'None active'
                )
              }
            />
            {/* "Pricing API" was the wrong name for this. The API was answering
                fine — in under 400ms — while this read "Degraded" purely because
                decisions had run on stale context. That is a pricing QUALITY
                signal, not an availability one, and labelling it as the API
                told the user their integration was broken when it was not. */}
            <StatusFact
              label="Pricing health"
              value={
                <HealthBadge verdict={health.verdict} />
              }
            />
            <StatusFact label="Response time" value={ms(health.p50)} />
            <StatusFact
              label="Decisions this hour"
              value={number(counters?.decisions_last_hour ?? null)}
            />
          </div>
          <LiveIndicator state={liveState} />
        </div>
      </Card>

      {/* Scoped: the project, strategy, health, decisions and charts all come
          from other endpoints and are still on screen. A page-wide alert here
          made a working dashboard look offline. */}
      {overview.error && (
        <ErrorState
          compact
          error={overview.error}
          title="Headline metrics are unavailable right now"
          onRetry={overview.refetch}
        />
      )}

      {/* ── the six metrics ────────────────────────────────────────────── */}
      {overview.initialLoading ? (
        <MetricGrid>
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonBlock key={i} height={96} />
          ))}
        </MetricGrid>
      ) : (
        kpis && (
          <MetricGrid>
            <Metric
              label="Average price"
              icon="projects"
              value={money(kpis.avg_price.value, currency)}
              change={kpis.avg_price.change_pct}
              changeIsGood
            />
            <Metric
              label="Price changes"
              icon="decisions"
              value={number(kpis.price_changes.value)}
              foot={`${percent(kpis.price_changes.rate_pct)} of decisions`}
            />
            <Metric
              label="Decisions"
              icon="simulation"
              value={number(kpis.decisions.value)}
              change={kpis.decisions.change_pct}
              changeIsGood
            />
          </MetricGrid>
        )
      )}

      {/* ── safety ─────────────────────────────────────────────────────── */}
      {safety && (
        <Card>
          <CardHeader
            title="Safety"
            subtitle={safetySummary(safety)}
            actions={
              safety.fallback_decisions > 0 || safety.degraded_decisions > 0 ? (
                // Same verdict the header shows, so one card cannot say
                // "Degraded" while the other says the project is just new.
                <HealthBadge verdict={health.verdict} />
              ) : (
                <Badge tone="success" icon="shield">
                  All clear
                </Badge>
              )
            }
          />
          <CardBody>
            <MetricGrid>
              <Metric
                label="Guardrail blocks"
                value={number(safety.guardrail_blocks)}
                foot="prices clamped to a limit"
              />
            </MetricGrid>
          </CardBody>
        </Card>
      )}

      {/* ── charts and live feed ───────────────────────────────────────── */}
      <MainWithSide>
        <Stack>
          <TimeChart
            title="Average price"
            syncId="overview"
            question="Where has pricing settled over time?"
            data={priceSeries.data}
            loading={priceSeries.loading}
            kind="line"
            format="money"
            currency={currency}
            emptyHint="No pricing decisions in this window yet."
          />
        </Stack>

        <Stack>
          <Card>
            <CardHeader
              title="Latest decisions"
              actions={
                // The full log is a tab on this same page now, so this scrolls
                // to it rather than linking to a route that no longer exists.
                <Button
                  variant="ghost"
                  size="sm"
                  iconAfter="arrow-right"
                  onClick={() => {
                    setTab('decisions');
                    document.getElementById('project-evidence')?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'start',
                    });
                  }}
                >
                  All
                </Button>
              }
            />
            <CardBody tight>
              {(pulse.data?.live_decisions ?? []).length === 0 ? (
                <EmptyState
                  compact
                  icon="decisions"
                  title="No decisions yet"
                  body="Call the pricing API for one of your items, or send an event, and decisions will appear here."
                  action={
                    <LinkButton to="/app/api" size="sm" variant="secondary">
                      View the API
                    </LinkButton>
                  }
                />
              ) : (
                <Stack tight>
                  {(pulse.data?.live_decisions ?? []).slice(0, 6).map((d) => (
                    <div
                      key={d.decision_id}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 'var(--s-3)',
                        fontSize: 'var(--t-sm)',
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{d.item_id}</span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--t-xs)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          {relativeTime(d.ts)}
                        </span>
                      </span>
                      <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span className="num" style={{ fontWeight: 500 }}>
                          {money(d.price, currency)}
                        </span>
                        {d.changed && (
                          <span
                            className="num"
                            style={{
                              display: 'block',
                              fontSize: 'var(--t-xs)',
                              color:
                                d.change_pct > 0 ? 'var(--success-text)' : 'var(--critical-text)',
                            }}
                          >
                            {percent(d.change_pct, { signed: true })}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </Stack>
              )}
            </CardBody>
          </Card>

          {!isLive && (
            <Card tone="accent" pad="md">
              <Row>
                <Icon name="sparkle" size={18} style={{ color: 'var(--accent)' }} />
                <strong style={{ fontSize: 'var(--t-sm)' }}>Not live yet</strong>
              </Row>
              <p
                style={{
                  marginTop: 'var(--s-2)',
                  fontSize: 'var(--t-sm)',
                  color: 'var(--text-secondary)',
                }}
              >
                Build a strategy, validate it, and promote it to active when you are ready. Nothing
                reaches a customer until you do.
              </p>
              <div style={{ marginTop: 'var(--s-4)' }}>
                <Button
                  variant="primary"
                  size="sm"
                  iconAfter="arrow-right"
                  onClick={() => navigate('/app/strategies')}
                >
                  Go to strategies
                </Button>
              </div>
            </Card>
          )}
        </Stack>
      </MainWithSide>

      {/* ── the evidence ─────────────────────────────────────────────────
          Tabs rather than more stacked cards: both of these are long, and a
          dashboard that needs two screens of scrolling before the first fact
          is not a dashboard. */}
      <Card pad="none" id="project-evidence">
        <div className={shell.tabs} role="tablist" aria-label="Project activity">
          {(['live', 'decisions'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={cx(shell.tab, tab === t && shell.tabOn)}
              onClick={() => setTab(t)}
            >
              <Icon name={t === 'live' ? 'live' : 'decisions'} size={15} />
              {t === 'live' ? 'Live activity' : 'Decisions'}
            </button>
          ))}
        </div>
        <div className={shell.tabBody}>
          {tab === 'live' ? <LiveSection /> : <DecisionsSection />}
        </div>
      </Card>
    </Stack>
  );
}

function PublishApprovalBanner({ projectId, onResolved }: { projectId: string; onResolved: () => void }) {
  const toast = useToast();
  const pending = useAsync(
    (signal) => strategiesApi.pendingPublish(projectId, { signal }),
    [projectId],
    { pollMs: 20_000 },
  );
  const p = pending.data?.pending;

  const approve = useMutation(
    () => strategiesApi.approvePublish(projectId, p!.approval_id),
    {
      onSuccess: () => {
        toast.success('Published', 'Your pricing is live from the next request.');
        pending.refetch();
        onResolved();
      },
      onError: (e) => toast.error('Could not publish', e.message),
    },
  );
  const reject = useMutation(
    () => strategiesApi.rejectPublish(projectId, p!.approval_id),
    {
      onSuccess: () => {
        toast.info('Dismissed', 'The change was not published.');
        pending.refetch();
        onResolved();
      },
    },
  );

  if (!p) return null;

  return (
    <Card tone="accent" pad="md">
      <Spread>
        <Row>
          <Icon name="clock" size={18} style={{ color: 'var(--accent)' }} />
          <div>
            <strong style={{ fontSize: 'var(--t-sm)' }}>
              A pricing change is waiting for approval
            </strong>
            <div style={{ fontSize: 'var(--t-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              {p.strategy_name ?? p.strategy_id} {p.version} — requested {relativeTime(p.requested_at)}.
              It will not go live until approved.
            </div>
          </div>
        </Row>
        <Row>
          <Button variant="ghost" loading={reject.pending} onClick={() => void reject.run()}>
            Dismiss
          </Button>
          <Button variant="primary" icon="check" loading={approve.pending} onClick={() => void approve.run()}>
            Approve &amp; publish
          </Button>
        </Row>
      </Spread>
    </Card>
  );
}

function StatusFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={shell.fact}>
      <span className={shell.factLabel}>{label}</span>
      <span className={cx(shell.factValue, 'num')}>{value}</span>
    </div>
  );
}

/**
 * One honest sentence about the safety counters.
 *
 * The old version keyed off a single `healthy` flag that only looked at
 * fallbacks, so it printed "every decision ran on fresh context" above a count
 * of 8 decisions that had not. Each state now describes what actually happened.
 */
function safetySummary(safety: {
  fallback_decisions: number;
  degraded_decisions: number;
  guardrail_blocks: number;
}): string {
  const { fallback_decisions: fb, degraded_decisions: dg, guardrail_blocks: gb } = safety;

  if (fb > 0) {
    return `${plural(fb, 'decision')} could not run the engine at all and fell back to the base price.`;
  }
  if (dg > 0) {
    return `${plural(dg, 'decision')} ran without every signal — the engine worked, but some signals were missing or out of date. On a new project this is simply everything that happened before your first events arrived.`;
  }
  if (gb > 0) {
    return `Every decision ran on fresh context. ${plural(gb, 'price')} was clamped by a guardrail.`;
  }
  return 'Every decision in this window ran on fresh context with guardrails satisfied.';
}
