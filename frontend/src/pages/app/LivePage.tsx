import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyticsApi, liveApi } from '@/api/endpoints';
import { Row, Spread, Stack } from '@/components/PageHeader';
import { Badge, LiveIndicator } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useAsync } from '@/hooks/useAsync';
import { useChannel, useLive, useResync } from '@/hooks/useLive';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { clockTime, humanise, money, number, percent, relativeTime } from '@/lib/format';
import type { AlertPayload, DecisionPayload, EventsPayload, SignalsPayload } from '@/lib/ws';
import s from './Live.module.css';

/**
 * The live dashboard.
 *
 * One merged timeline rather than four separate feeds, because the story is
 * causal: a booking arrives, occupancy moves, a rule fires, the price changes.
 * Four parallel lists would hide exactly the relationship that makes the
 * platform legible.
 *
 * State comes from two places and they must not fight:
 *
 *  - `/live/pulse` paints the initial view and is the authority after a
 *    reconnect, because the socket has no backlog.
 *  - the WebSocket appends to it from then on.
 *
 * So the feed is seeded once from pulse, and a reconnect reseeds it rather than
 * appending to a view with an unknown gap in the middle.
 */

type Kind = 'event' | 'decision' | 'alert' | 'signal';

interface FeedRow {
  id: string;
  kind: Kind;
  ts: number;
  text: string;
  sub?: string;
  value?: string;
  delta?: string;
  deltaTone?: 'up' | 'down';
}

const KIND_ICON: Record<Kind, IconName> = {
  event: 'arrow-right',
  decision: 'decisions',
  alert: 'warning',
  signal: 'analytics',
};

const KIND_CLASS: Record<Kind, string | undefined> = {
  event: s.kindEvent,
  decision: s.kindDecision,
  alert: s.kindAlert,
  signal: s.kindSignal,
};

/** Keeps the feed bounded. Anything older is available via the REST endpoints. */
const MAX_ROWS = 120;

/**
 * Live activity, as a section of the project dashboard.
 *
 * It used to be its own route. "What is happening right now" is the same
 * question the dashboard already exists to answer, so it lives there as a tab
 * rather than as a separate place to remember to visit.
 */
export function LiveSection() {
  const { project, projectId } = useSession();
  const { state } = useLive();
  const toast = useToast();

  const [rows, setRows] = useState<FeedRow[]>([]);
  const [signals, setSignals] = useState<Record<string, { value: number | string; ts: number }>>({});
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);

  const feedRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const freshIds = useRef<Set<string>>(new Set());

  const currency = project?.currency ?? 'INR';

  const pulse = useAsync(
    (signal) => liveApi.pulse(projectId!, { events: 20, decisions: 15 }, { signal }),
    [projectId],
    // A slow poll as a safety net. The socket is the real source; this catches
    // the case where it is silently half-open despite the keepalive.
    { enabled: !!projectId, pollMs: 60_000 },
  );

  const pipeline = useAsync(
    (signal) => analyticsApi.pipeline(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 30_000 },
  );

  /* ── seeding from pulse ──────────────────────────────────────────────── */

  const seed = useCallback(() => {
    const data = pulse.data;
    if (!data) return;

    const seeded: FeedRow[] = [];

    for (const d of data.live_decisions ?? []) {
      seeded.push(decisionRow(d, currency, `seed-d-${d.decision_id}`));
    }
    for (const e of data.live_events ?? []) {
      seeded.push({
        id: `seed-e-${e.ts}-${e.item_id}-${e.event_type}`,
        kind: 'event',
        ts: e.ts,
        text: humanise(e.event_type),
        sub: e.item_id,
        // `quantity` is absent on most event types and typed as unknown, so it
        // is narrowed rather than cast — an event carrying a non-numeric value
        // here should render nothing, not "×[object Object]".
        value: typeof e.quantity === 'number' ? `×${number(e.quantity)}` : undefined,
      });
    }
    for (const a of data.alerts ?? []) {
      seeded.push({
        id: `seed-a-${a.alert_id}`,
        kind: 'alert',
        ts: a.ts,
        text: a.title,
        sub: a.needs_decision ? 'Waiting on a decision' : a.severity,
      });
    }

    seeded.sort((a, b) => b.ts - a.ts);
    // Replace rather than merge: this runs on first load and after a reconnect,
    // and in both cases pulse is the authority on what the current view is.
    setRows(seeded.slice(0, MAX_ROWS));
  }, [pulse.data, currency]);

  useEffect(() => {
    seed();
  }, [seed]);

  useResync(() => {
    pulse.refetch();
    toast.info('Reconnected', 'Live view resynchronised from the server.');
  });

  /* ── appending from the socket ───────────────────────────────────────── */

  const push = useCallback(
    (incoming: FeedRow[]) => {
      if (paused || incoming.length === 0) return;
      for (const r of incoming) freshIds.current.add(r.id);
      setRows((prev) => [...incoming, ...prev].slice(0, MAX_ROWS));
      // Clear the "new" marks shortly after, so the insert animation plays once
      // and later re-renders do not replay it.
      window.setTimeout(() => {
        for (const r of incoming) freshIds.current.delete(r.id);
      }, 600);
    },
    [paused],
  );

  useChannel('events', (data: EventsPayload) => {
    push(
      (data.events ?? []).map((e) => ({
        id: `e-${++seq.current}`,
        kind: 'event' as const,
        ts: e.ts ?? Date.now(),
        text: humanise(e.event_type),
        sub: e.item_id,
        value: e.quantity ? `×${number(e.quantity)}` : undefined,
      })),
    );
  });

  useChannel('decisions', (d: DecisionPayload) => {
    push([decisionRow({ ...d, ts: Date.now() }, currency, `d-${++seq.current}`)]);
  });

  useChannel('alerts', (a: AlertPayload) => {
    push([
      {
        id: `a-${++seq.current}`,
        kind: 'alert',
        ts: Date.now(),
        text: a.title,
        sub: a.needs_decision ? 'Waiting on a decision' : (a.message ?? a.severity),
      },
    ]);
    if (a.severity === 'critical') {
      toast.error(a.title, a.message ?? 'Open the alerts page to review it.');
    }
  });

  useChannel('kpis', (payload: SignalsPayload) => {
    if (payload.type !== 'signals') return;
    const entries = Object.entries(payload.signals ?? {});
    if (entries.length === 0) return;

    const now = Date.now();
    setSignals((prev) => {
      const next = { ...prev };
      for (const [k, v] of entries) {
        if (typeof v === 'boolean') continue;
        next[k] = { value: v, ts: now };
      }
      return next;
    });

    // Flash the cards that changed, then stop. Without clearing, every card
    // would stay highlighted and the highlight would stop meaning anything.
    const keys = new Set(entries.map(([k]) => k));
    setFlashing(keys);
    window.setTimeout(() => setFlashing(new Set()), 950);

    push([
      {
        id: `s-${++seq.current}`,
        kind: 'signal',
        ts: now,
        text: 'Context updated',
        sub: `${payload.item_id} · ${entries.map(([k]) => k).join(', ')}`,
      },
    ]);
  });


  const counters = pulse.data?.counters;
  const status = pulse.data?.status;

  const signalEntries = useMemo(
    () =>
      Object.entries(signals)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 8),
    [signals],
  );

  // Signal freshness from the pipeline endpoint, which reports the real ages —
  // more trustworthy than inferring staleness from when this tab last saw a frame.
  const freshness = pipeline.data?.data_freshness;

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="projects"
          title="No project selected"
          body="Create a project to start seeing live pricing activity."
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
      <Spread>
        <div className={s.sectionNote}>
          Events arriving, context updating, rules firing and prices changing — in the order
          they happen.
        </div>
        <Row>
          <LiveIndicator state={state} />
          <Button
            size="sm"
            variant={paused ? 'primary' : 'secondary'}
            icon={paused ? 'play' : 'pause'}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </Row>
      </Spread>

      {pulse.error && <ErrorState error={pulse.error} onRetry={pulse.refetch} />}

      <MetricGrid>
        <Metric
          label="Decisions / hour"
          icon="decisions"
          value={number(counters?.decisions_last_hour ?? null)}
        />
        <Metric
          label="Price changes / hour"
          icon="analytics"
          value={number(counters?.price_changes_last_hour ?? null)}
        />
        <Metric
          label="Events / min"
          icon="live"
          value={number(pipeline.data?.summary?.events_per_min ?? null)}
        />
        <Metric
          label="Open alerts"
          icon="alerts"
          value={number(counters?.open_alerts ?? null)}
          foot={
            (counters?.critical_alerts ?? 0) > 0
              ? `${number(counters?.critical_alerts ?? 0)} critical`
              : undefined
          }
        />
      </MetricGrid>

      <div className={s.layout}>
        {/* ── timeline ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Activity"
            subtitle={
              status?.live
                ? 'Live traffic. Newest first.'
                : 'This project is not active, so only test and simulated activity appears here.'
            }
            actions={
              <Badge tone="neutral">
                {rows.length >= MAX_ROWS ? `${MAX_ROWS}+` : number(rows.length)} entries
              </Badge>
            }
          />

          {pulse.initialLoading ? (
            <Loading label="Loading live activity" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="live"
              title="No live activity yet"
              body="Connect your event API so DevNexus can see what is happening."
              action={
                <Row>
                  <LinkButton to="/app/api" variant="primary">
                    View the event API
                  </LinkButton>
                </Row>
              }
            />
          ) : (
            <div className={s.feed} ref={feedRef}>
              {rows.map((r) => (
                <div
                  key={r.id}
                  className={cx(s.row, freshIds.current.has(r.id) && s.rowNew)}
                >
                  <span className={s.time}>{clockTime(r.ts)}</span>
                  <span className={cx(s.kind, KIND_CLASS[r.kind])}>
                    <Icon name={KIND_ICON[r.kind]} size={12} strokeWidth={2} />
                  </span>
                  <span className={s.text}>
                    {r.text}
                    {r.sub && <span className={s.sub}>{r.sub}</span>}
                  </span>
                  <span className={s.value}>
                    {r.value}
                    {r.delta && (
                      <span
                        className={cx(
                          s.delta,
                          r.deltaTone === 'up' ? s.up : r.deltaTone === 'down' ? s.down : undefined,
                        )}
                      >
                        {r.delta}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {paused && (
            <div className={s.paused}>
              <Icon name="pause" size={12} />
              Paused — new activity is not being added. Resume to catch up.
            </div>
          )}
        </Card>

        {/* ── side panels ──────────────────────────────────────────────── */}
        <Stack>
          <Card>
            <CardHeader
              title="Context signals"
              subtitle="The values the engine is evaluating right now."
            />
            <CardBody tight>
              {signalEntries.length === 0 ? (
                <EmptyState
                  compact
                  icon="analytics"
                  title="No signals received yet"
                  body="Signals update as your events arrive. Send an event, or generate traffic, to see them move."
                />
              ) : (
                <div className={s.signalGrid}>
                  {signalEntries.map(([key, entry]) => {
                    const stale = freshness?.signals?.find((f) => f.signal === key)?.stale ?? false;
                    return (
                      <div key={key} className={s.signal}>
                        <div className={s.signalName} title={key}>
                          {humanise(key)}
                        </div>
                        <div
                          className={cx(s.signalValue, flashing.has(key) && s.signalFlash)}
                        >
                          {typeof entry.value === 'number'
                            ? entry.value < 1 && entry.value > 0
                              ? entry.value.toFixed(2)
                              : number(entry.value, Number.isInteger(entry.value) ? 0 : 1)
                            : String(entry.value)}
                        </div>
                        <div className={cx(s.signalMeta, stale && s.stale)}>
                          {stale ? 'stale' : relativeTime(entry.ts)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardBody>
          </Card>
        </Stack>
      </div>
    </Stack>
  );
}

/** Shared by the seed path and the socket path, so a decision row looks identical
 *  whichever way it arrived. */
function decisionRow(
  d: {
    decision_id: string;
    item_id: string;
    price: number;
    previous_price: number | null;
    changed: boolean;
    change_pct: number;
    rules_fired: string[];
    degraded?: boolean;
    fallback?: boolean;
    ts?: number;
  },
  currency: string,
  id: string,
): FeedRow {
  const fired = d.rules_fired ?? [];
  return {
    id,
    kind: 'decision',
    ts: d.ts ?? Date.now(),
    text: d.changed ? 'Price changed' : 'Price held',
    sub: [
      d.item_id,
      fired.length > 0 ? fired.join(', ') : 'no rules fired',
      d.fallback ? 'fallback' : d.degraded ? 'degraded context' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    value: money(d.price, currency),
    delta: d.changed ? percent(d.change_pct, { signed: true }) : undefined,
    deltaTone: d.change_pct > 0 ? 'up' : 'down',
  };
}
