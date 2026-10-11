import { useState } from 'react';
import { alertsApi, approvalsApi, type AlertStatus, type Severity } from '@/api/endpoints';
import { useApprovals } from '@/hooks/useApprovals';
import type { AlertListResponse } from '@/api/types';
import { PageHeader, Row, Stack } from '@/components/PageHeader';
import { Badge, SeverityBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { Table, type Column } from '@/components/ui/Table';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { dateTime, number, relativeTime } from '@/lib/format';
import { PendingDecision } from './parts/PendingDecision';

/**
 * Alerts, and the decisions they are waiting on.
 *
 * Pending approvals sit at the top, above the alert list, because an approval is
 * something blocking — the platform has stopped and is waiting for a person.
 * An alert, by contrast, is a record of something that already happened.
 */

const STATUS_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

type Alert = AlertListResponse['alerts'][number];

export default function AlertsPage() {
  const { project, projectId } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');

  const alerts = useAsync(
    (signal) =>
      alertsApi.list(
        {
          project_id: projectId ?? undefined,
          status: status === 'all' ? undefined : (status as AlertStatus),
          severity: severity === 'all' ? undefined : severity,
          limit: 100,
        },
        { signal },
      ),
    [projectId, status, severity],
    { enabled: !!projectId, pollMs: 45_000 },
  );

  const pending = useApprovals();

  const history = useAsync(
    (signal) => approvalsApi.history({ project_id: projectId ?? undefined, limit: 10 }, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const ack = useMutation(
    (alertId: string, action: 'ack' | 'resolve' | 'dismiss', ts: number) =>
      alertsApi.ack(alertId, action, { ts }),
    {
      onSuccess: () => {
        toast.success('Alert updated');
        alerts.refetch();
      },
      onError: (e) => toast.error('Could not update the alert', e.message),
    },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="alerts"
          title="No project selected"
          body="Create a project to start receiving pricing alerts."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const rows = alerts.data?.alerts ?? [];
  const summary = alerts.data?.summary;
  const pendingItems = pending.approvals;

  const columns: readonly Column<Alert>[] = [
    {
      key: 'severity',
      header: 'Severity',
      // Ordered by urgency, not alphabetically — "critical" must outrank "info".
      sortBy: (a) => ({ critical: 0, warning: 1, info: 2 })[a.severity] ?? 3,
      render: (a) => <SeverityBadge severity={a.severity} />,
    },
    {
      key: 'ts',
      header: 'When',
      nowrap: true,
      sortBy: (a) => a.ts,
      sortDescFirst: true,
      render: (a) => <span title={dateTime(a.ts)}>{relativeTime(a.ts)}</span>,
    },
    {
      key: 'title',
      header: 'What happened',
      render: (a) => (
        <span>
          {a.title}
          {a.message && (
            <span style={{ display: 'block', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
              {a.message}
            </span>
          )}
        </span>
      ),
    },
    { key: 'item', header: 'Item', mono: true, muted: true, render: (a) => a.item_id || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (a) =>
        a.approval_id ? (
          <Badge tone="critical" icon="warning">
            Needs a decision
          </Badge>
        ) : (
          <Badge tone={a.status === 'open' ? 'warning' : 'neutral'} caps>
            {a.status}
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) =>
        a.status === 'open' && !a.approval_id ? (
          <Row>
            <Button
              size="sm"
              variant="ghost"
              loading={ack.pending}
              onClick={() => void ack.run(a.alert_id, 'ack', a.ts)}
            >
              Acknowledge
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={ack.pending}
              onClick={() => void ack.run(a.alert_id, 'resolve', a.ts)}
            >
              Resolve
            </Button>
          </Row>
        ) : null,
    },
  ];

  return (
    <Stack>
      <PageHeader
        title="Alerts"
        description="Anything DevNexus noticed about your pricing. Critical alerts that need a human call appear as a question you can answer here."
        actions={
          <Row>
            <Segmented label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
            <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={alerts.refetch} />
          </Row>
        }
      />

      {/* Blocking decisions first. */}
      {pendingItems.length > 0 && (
        <PendingDecision
          approvals={pendingItems}
          onAnswered={() => {
            pending.refetch();
            alerts.refetch();
            history.refetch();
          }}
        />
      )}

      {summary && (
        <MetricGrid>
          <Metric label="Open" icon="alerts" value={number(summary.by_status.open)} />
          <Metric label="Critical" icon="critical" value={number(summary.by_severity.critical)} />
          <Metric label="Warning" icon="warning" value={number(summary.by_severity.warning)} />
          <Metric label="Resolved" icon="check" value={number(summary.by_status.resolved)} />
        </MetricGrid>
      )}

      <Row>
        <Segmented
          label="Severity"
          value={severity}
          options={[
            { value: 'all' as const, label: 'All severities' },
            { value: 'critical' as const, label: 'Critical' },
            { value: 'warning' as const, label: 'Warning' },
            { value: 'info' as const, label: 'Info' },
          ]}
          onChange={setSeverity}
        />
      </Row>

      {alerts.error && (
        <ErrorState
          compact
          error={alerts.error}
          title="The alert list could not be loaded"
          onRetry={alerts.refetch}
        />
      )}

      <Card>
        <CardHeader title="Alert history" />
        {alerts.initialLoading ? (
          <Loading label="Loading alerts" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="check"
            title={status === 'open' ? 'Nothing needs your attention' : 'No alerts match these filters'}
            body={
              status === 'open'
                ? 'DevNexus raises an alert when a price moves unusually, a guardrail blocks something repeatedly, or the pipeline falls behind. There is nothing open right now.'
                : 'Try a different status or severity.'
            }
          />
        ) : (
          <Table
            caption="Alerts"
            columns={columns}
            rows={rows}
            rowKey={(a) => a.alert_id}
            defaultSort="ts"
          />
        )}
      </Card>

      {/* ── what has already been decided ─────────────────────────────── */}
      {(history.data?.approvals ?? []).length > 0 && (
        <Card>
          <CardHeader
            title="Past decisions"
            subtitle="Questions DevNexus asked, and what was chosen."
          />
          <CardBody tight>
            <Stack tight>
              {(history.data?.approvals ?? []).map((h) => (
                <div
                  key={h.approval_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 'var(--s-4)',
                    padding: 'var(--s-3)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--surface-sunken)',
                    fontSize: 'var(--t-sm)',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    {h.question}
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--t-xs)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {h.answered_at ? dateTime(h.answered_at) : 'not answered'}
                      {h.answered_by ? ` · ${h.answered_by}` : ''}
                    </span>
                  </span>
                  <span style={{ textAlign: 'right', flexShrink: 0 }}>
                    {h.chosen_label ? (
                      <Badge tone={h.followed_recommendation ? 'success' : 'warning'}>
                        {h.chosen_label}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{h.status}</Badge>
                    )}
                  </span>
                </div>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}

      {pendingItems.length === 0 && rows.length > 0 && (
        <Card pad="sm">
          <Row>
            <Icon name="info" size={15} style={{ color: 'var(--info-text)' }} />
            <span style={{ fontSize: 'var(--t-sm)', color: 'var(--text-secondary)' }}>
              Critical alerts that need a decision appear at the top of this page and as a push
              notification on your device.
            </span>
          </Row>
        </Card>
      )}
    </Stack>
  );
}
