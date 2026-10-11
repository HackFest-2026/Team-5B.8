import { useState } from 'react';
import { auditApi } from '@/api/endpoints';
import type { AuditListResponse } from '@/api/types';
import { PageHeader, Row, Stack } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { dateTime, humanise, number, relativeTime } from '@/lib/format';
import s from './Audit.module.css';

/**
 * The audit trail.
 *
 * A timeline rather than a table: the value of an audit log is the sequence —
 * who changed what, in what order, and what happened next. A sortable grid
 * invites re-sorting, which destroys exactly that.
 *
 * Every action gets an icon and plain-English wording. `STRATEGY_PROMOTED` is
 * accurate but it is not what a person reading an incident timeline wants to see.
 */

type Entry = AuditListResponse['entries'][number];

/** Wording and iconography per action. Unknown actions degrade gracefully. */
const ACTIONS: Record<string, { label: string; icon: IconName; tone: 'accent' | 'warning' | 'critical' | 'neutral' }> = {
  TENANT_CREATED: { label: 'Workspace created', icon: 'projects', tone: 'accent' },
  PROJECT_CREATED: { label: 'Project created', icon: 'projects', tone: 'accent' },
  DOMAIN_SAVED: { label: 'Domain schema saved', icon: 'data', tone: 'neutral' },
  GUARDRAILS_SAVED: { label: 'Guardrails changed', icon: 'shield', tone: 'warning' },
  ITEM_CREATED: { label: 'Item added', icon: 'projects', tone: 'neutral' },
  RULE_CREATED: { label: 'Rule created', icon: 'rules', tone: 'neutral' },
  RULE_UPDATED: { label: 'Rule changed', icon: 'rules', tone: 'warning' },
  STRATEGY_CREATED: { label: 'Strategy created', icon: 'strategies', tone: 'neutral' },
  STRATEGY_UPDATED: { label: 'Strategy changed', icon: 'strategies', tone: 'warning' },
  STRATEGY_VALIDATED: { label: 'Strategy validated', icon: 'check', tone: 'neutral' },
  STRATEGY_PROMOTED: { label: 'Strategy promoted', icon: 'play', tone: 'accent' },
  STRATEGY_ROLLED_BACK: { label: 'Rolled back', icon: 'rollback', tone: 'critical' },
  BACKTEST_STARTED: { label: 'Backtest started', icon: 'analytics', tone: 'neutral' },
  BACKTEST_COMPLETED: { label: 'Backtest completed', icon: 'analytics', tone: 'neutral' },
  DATA_UPLOADED: { label: 'Data uploaded', icon: 'upload', tone: 'neutral' },
  ALERT_RAISED: { label: 'Alert raised', icon: 'alerts', tone: 'warning' },
  ALERT_ACKNOWLEDGED: { label: 'Alert acknowledged', icon: 'check', tone: 'neutral' },
  APPROVAL_REQUESTED: { label: 'Decision requested', icon: 'bell', tone: 'warning' },
  APPROVAL_ANSWERED: { label: 'Decision made', icon: 'check', tone: 'accent' },
  APIKEY_ROTATED: { label: 'API key rotated', icon: 'api', tone: 'critical' },
};

const ENTITY_FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'strategy', label: 'Strategies' },
  { value: 'rule', label: 'Rules' },
  { value: 'project', label: 'Projects' },
  { value: 'item', label: 'Items' },
  { value: 'alert', label: 'Alerts' },
  { value: 'approval', label: 'Decisions' },
];

export default function AuditPage() {
  const { project, projectId } = useSession();
  const [entityType, setEntityType] = useState('');

  const audit = useAsync(
    (signal) =>
      auditApi.list(
        {
          project_id: projectId ?? undefined,
          entity_type: entityType || undefined,
          limit: 100,
        },
        { signal },
      ),
    [projectId, entityType],
    { enabled: !!projectId },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="audit"
          title="No project selected"
          body="Create a project to start building an audit trail."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const entries = audit.data?.entries ?? [];

  return (
    <Stack>
      <PageHeader
        title="Audit"
        description="Everything that has changed in this project, in order, with who did it. Nothing here can be edited or removed."
        actions={
          <Row>
            <Select
              aria-label="Filter by what changed"
              value={entityType}
              options={ENTITY_FILTERS}
              onChange={(e) => setEntityType(e.target.value)}
            />
            <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={audit.refetch} />
          </Row>
        }
      />

      {audit.error && <ErrorState error={audit.error} onRetry={audit.refetch} />}

      <Card>
        <CardHeader
          title="Timeline"
          subtitle={entries.length > 0 ? `${number(entries.length)} most recent entries` : undefined}
        />
        {audit.initialLoading ? (
          <Loading label="Loading the audit trail" />
        ) : entries.length === 0 ? (
          <EmptyState
            icon="audit"
            title={entityType ? 'Nothing matches that filter' : 'Nothing recorded yet'}
            body={
              entityType
                ? 'Try a different filter, or show everything.'
                : 'The audit trail fills in as you configure this project — every rule, strategy and promotion is recorded automatically.'
            }
            action={
              entityType ? (
                <Button variant="secondary" onClick={() => setEntityType('')}>
                  Show everything
                </Button>
              ) : undefined
            }
          />
        ) : (
          <CardBody tight>
            <div className={s.timeline}>
              {entries.map((entry) => (
                <AuditEntry key={entry.audit_id} entry={entry} />
              ))}
            </div>
            {audit.data?.cursor && (
              <p
                style={{
                  marginTop: 'var(--s-4)',
                  fontSize: 'var(--t-xs)',
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                }}
              >
                Older entries exist beyond this page.
              </p>
            )}
          </CardBody>
        )}
      </Card>
    </Stack>
  );
}

function AuditEntry({ entry }: { entry: Entry }) {
  const meta = ACTIONS[entry.action] ?? {
    label: humanise(entry.action.toLowerCase()),
    icon: 'dot' as IconName,
    tone: 'neutral' as const,
  };

  const changes = describeChange(entry);

  return (
    <div className={s.entry}>
      <div className={s.rail}>
        <span className={`${s.dot} ${s[meta.tone]}`}>
          <Icon name={meta.icon} size={12} strokeWidth={2} />
        </span>
      </div>

      <div className={s.body}>
        <div className={s.head}>
          <span className={s.action}>{meta.label}</span>
          {entry.strategy_version && <Badge tone="neutral">{entry.strategy_version}</Badge>}
          <span className={s.time} title={dateTime(entry.ts)}>
            {relativeTime(entry.ts)}
          </span>
        </div>

        <div className={s.detail}>
          <span className={s.entity}>
            {entry.entity_type}
            {entry.entity_id ? ` · ${entry.entity_id}` : ''}
          </span>
          {entry.actor && (
            <span className={s.actor}>
              by {entry.actor}
              {entry.source && entry.source !== 'web' ? ` (${entry.source})` : ''}
            </span>
          )}
        </div>

        {changes.length > 0 && (
          <div className={s.changes}>
            {changes.map((c) => (
              <span key={c} className={s.change}>
                {c}
              </span>
            ))}
          </div>
        )}

        {entry.note && <div className={s.note}>{entry.note}</div>}
      </div>
    </div>
  );
}

/**
 * Turn the recorded value into something readable.
 *
 * `new_value` is an open record whose shape depends on the action, so this reads
 * it defensively and shows nothing rather than guessing when it does not
 * recognise the contents.
 */
function describeChange(entry: Entry): string[] {
  const out: string[] = [];
  const next = entry.new_value;
  const prev = entry.old_value;

  if (!next || typeof next !== 'object') return out;

  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // nested detail is not worth a chip
    const before = prev && typeof prev === 'object' ? (prev as Record<string, unknown>)[key] : undefined;
    const label = humanise(key).toLowerCase();
    if (before !== undefined && before !== null && typeof before !== 'object' && before !== value) {
      out.push(`${label}: ${String(before)} → ${String(value)}`);
    } else {
      out.push(`${label}: ${String(value)}`);
    }
  }

  return out.slice(0, 5);
}
