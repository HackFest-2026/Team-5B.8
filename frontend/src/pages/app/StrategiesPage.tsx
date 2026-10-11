import { useState } from 'react';
import { rulesApi, strategiesApi, type PromoteMode } from '@/api/endpoints';
import type { StrategyListResponse, ValidateStrategyResponse } from '@/api/types';
import { KeyValues, MainWithSide, Note, PageHeader, Row, Stack, Well } from '@/components/PageHeader';
import { Badge, ModeBadge, PipelineRail, STRATEGY_STAGES } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading, SkeletonText } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { dateTime, number, plural } from '@/lib/format';

/**
 * The strategy workspace.
 *
 * The lifecycle is the organising idea: a strategy is DRAFT, VALIDATED, SHADOW,
 * ACTIVE or PAUSED, and the only actions offered are the ones legal from where it
 * is. Offering "Activate" on an unvalidated draft would mean showing a button
 * whose only outcome is a server error.
 *
 * Promotion to ACTIVE and rollback both change what live customers are charged,
 * so both are confirmed with the consequence spelled out. Nothing else is.
 */

type Strategy = StrategyListResponse['strategies'][number];

/**
 * The distinct versions of a strategy, in the order they first appeared.
 *
 * `versions` is an append-only history, so a rollback puts an earlier version
 * back on the end: a real strategy comes back as `v1, v2, v3, v2, v3, v4`.
 * Rendering that raw looks like a bug, and it would offer the same version three
 * times in the rollback picker.
 */
function distinctVersions(strategy: Strategy): string[] {
  return [...new Set(strategy.versions)];
}

export default function StrategiesPage() {
  const { project, projectId, refresh } = useSession();
  const toast = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState<{ strategy: Strategy; mode: PromoteMode } | null>(null);
  const [rollingBack, setRollingBack] = useState<Strategy | null>(null);
  const [rollbackTo, setRollbackTo] = useState('');
  const [validation, setValidation] = useState<ValidateStrategyResponse | null>(null);

  const list = useAsync(
    (signal) => strategiesApi.list(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const strategies = list.data?.strategies ?? [];
  const selected = strategies.find((st) => st.strategy_id === selectedId) ?? strategies[0] ?? null;

  const detail = useAsync(
    (signal) => strategiesApi.get(projectId!, selected!.strategy_id, undefined, { signal }),
    [projectId, selected?.strategy_id],
    { enabled: !!projectId && !!selected },
  );

  const validate = useMutation(
    (strategyId: string) => strategiesApi.validate(projectId!, strategyId),
    {
      onSuccess: (result) => {
        setValidation(result);
        if (result.passed) {
          toast.success('Validation passed', result.next_step);
          list.refetch();
        }
      },
    },
  );

  const promote = useMutation(
    (strategyId: string, mode: PromoteMode) => strategiesApi.promote(projectId!, strategyId, mode),
    {
      onSuccess: () => {
        setPromoting(null);
        toast.success('Strategy updated', 'The lifecycle state has changed.');
        list.refetch();
        // The project row carries the active strategy and mode, which the shell
        // and dashboard both read, so the session has to be refreshed too.
        void refresh();
      },
    },
  );

  const rollback = useMutation(
    (strategyId: string, toVersion: string) =>
      strategiesApi.rollback(projectId!, strategyId, toVersion),
    {
      onSuccess: () => {
        setRollingBack(null);
        toast.success('Rolled back', 'Live pricing is using the earlier version from now on.');
        list.refetch();
        void refresh();
      },
    },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="strategies"
          title="No project selected"
          body="Create a project before building a pricing strategy."
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
        title="Strategies"
        description="A strategy is a versioned set of rules. It moves through draft, validation, shadow and active — nothing reaches a customer until you promote it."
        actions={
          <Row>
            <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={list.refetch} />
            <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New strategy
            </Button>
          </Row>
        }
      />

      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}

      {list.initialLoading ? (
        <Loading label="Loading strategies" />
      ) : strategies.length === 0 ? (
        <Card>
          <EmptyState
            icon="strategies"
            title="No strategy yet"
            body="A strategy bundles your rules into something you can test and promote as a unit. Create your first one, then validate it before it goes anywhere near live traffic."
            action={
              <Row>
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  Create strategy
                </Button>
                <LinkButton to="/app/rules" variant="secondary">
                  Write rules first
                </LinkButton>
              </Row>
            }
          />
        </Card>
      ) : (
        <MainWithSide>
          <Stack>
            {strategies.map((st) => {
              const isActive = st.strategy_id === list.data?.active_strategy_id;
              const isShadow = st.strategy_id === list.data?.shadow_strategy_id;
              return (
                <Card
                  key={st.strategy_id}
                  tone={isActive ? 'accent' : 'default'}
                  className={selected?.strategy_id === st.strategy_id ? undefined : undefined}
                >
                  <CardHeader
                    title={
                      <Row>
                        {st.name}
                        <Badge tone="neutral">{st.version}</Badge>
                        <ModeBadge mode={st.mode} />
                        {isShadow && (
                          <Badge tone="info" caps>
                            shadow {list.data?.shadow_version}
                          </Badge>
                        )}
                      </Row>
                    }
                    subtitle={`${plural(st.rule_count, 'rule')} · ${plural(
                      distinctVersions(st).length,
                      'version',
                    )} · updated ${dateTime(st.updated_at)}`}
                    actions={
                      <Row>
                        <Button
                          size="sm"
                          variant={selected?.strategy_id === st.strategy_id ? 'secondary' : 'ghost'}
                          onClick={() => {
                            setSelectedId(st.strategy_id);
                            setValidation(null);
                          }}
                        >
                          {selected?.strategy_id === st.strategy_id ? 'Viewing' : 'View'}
                        </Button>
                      </Row>
                    }
                  />
                  <CardBody tight>
                    <Stack tight>
                      <PipelineRail stages={STRATEGY_STAGES} currentId={st.mode} />
                      <LifecycleActions
                        strategy={st}
                        validating={validate.pending}
                        promoting={promote.pending}
                        onValidate={() => {
                          setSelectedId(st.strategy_id);
                          void validate.run(st.strategy_id);
                        }}
                        onPromote={(mode) => {
                          // Only the states that affect live traffic get a
                          // confirmation; routine moves do not.
                          if (mode === 'active' || mode === 'paused') {
                            setPromoting({ strategy: st, mode });
                          } else {
                            void promote.run(st.strategy_id, mode);
                          }
                        }}
                        onRollback={() => {
                          setRollingBack(st);
                          // The version before the current one, by history.
                          const distinct = distinctVersions(st).filter(
                            (v) => v !== st.version,
                          );
                          setRollbackTo(distinct[distinct.length - 1] ?? '');
                        }}
                      />
                    </Stack>
                  </CardBody>
                </Card>
              );
            })}
          </Stack>

          {/* ── detail ─────────────────────────────────────────────────── */}
          <Stack>
            {validation && (
              <ValidationReport report={validation} onDismiss={() => setValidation(null)} />
            )}

            {selected && (
              <Card>
                <CardHeader
                  title={selected.name}
                  subtitle={`Version ${detail.data?.strategy.version ?? selected.version}`}
                />
                <CardBody>
                  {detail.initialLoading ? (
                    <SkeletonText lines={5} />
                  ) : detail.error ? (
                    <ErrorState error={detail.error} onRetry={detail.refetch} />
                  ) : detail.data ? (
                    <Stack>
                      <KeyValues
                        rows={[
                          { key: 'Rules compiled', value: number(detail.data.compiled.rule_count) },
                          { key: 'Mode', value: <ModeBadge mode={detail.data.strategy.mode} /> },
                          {
                            key: 'Versions',
                            value: [...new Set(detail.data.strategy.versions)].join(', '),
                          },
                          {
                            key: 'Compiled',
                            value: dateTime(detail.data.compiled.compiled_at_ms),
                          },
                        ]}
                      />

                      {detail.data.guardrail_explanation.length > 0 && (
                        <Well>
                          <strong style={{ fontSize: 'var(--t-sm)' }}>Guardrails in force</strong>
                          <ul
                            style={{
                              marginTop: 'var(--s-2)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 'var(--s-1)',
                              fontSize: 'var(--t-sm)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {detail.data.guardrail_explanation.map((g) => (
                              <li key={g}>· {g}</li>
                            ))}
                          </ul>
                        </Well>
                      )}

                      <div>
                        <strong style={{ fontSize: 'var(--t-sm)' }}>Rules in this version</strong>
                        <Stack tight>
                          {detail.data.rules.map((r) => (
                            <div
                              key={r.rule_id}
                              style={{
                                marginTop: 'var(--s-2)',
                                padding: 'var(--s-3)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--r-md)',
                                background: 'var(--surface-sunken)',
                              }}
                            >
                              <Row>
                                <strong style={{ fontSize: 'var(--t-sm)' }}>{r.name}</strong>
                                <Badge tone="neutral">p{r.priority}</Badge>
                                {r.conflict_group && (
                                  <Badge tone="info">{r.conflict_group}</Badge>
                                )}
                                {!r.stackable && <Badge tone="warning">exclusive</Badge>}
                                {!r.enabled && <Badge tone="neutral">disabled</Badge>}
                              </Row>
                              <p
                                style={{
                                  marginTop: 'var(--s-2)',
                                  fontSize: 'var(--t-sm)',
                                  color: 'var(--text-secondary)',
                                  lineHeight: 'var(--lh-snug)',
                                }}
                              >
                                {r.explanation}
                              </p>
                            </div>
                          ))}
                        </Stack>
                      </div>
                    </Stack>
                  ) : null}
                </CardBody>
              </Card>
            )}
          </Stack>
        </MainWithSide>
      )}

      {creating && projectId && (
        <CreateStrategyModal
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            list.refetch();
          }}
        />
      )}

      {/* ── promote confirmation ─────────────────────────────────────── */}
      <ConfirmDialog
        open={!!promoting}
        onClose={() => {
          setPromoting(null);
          promote.reset();
        }}
        onConfirm={() => {
          if (promoting) void promote.run(promoting.strategy.strategy_id, promoting.mode);
        }}
        title={promoting?.mode === 'active' ? 'Activate this strategy?' : 'Pause this strategy?'}
        body={
          promoting?.mode === 'active' ? (
            <>
              <strong>{promoting.strategy.name}</strong> will start pricing real customers from the
              next API request.
            </>
          ) : (
            <>
              <strong>{promoting?.strategy.name}</strong> will stop pricing. Requests will fall back
              to each item&apos;s base price until a strategy is active again.
            </>
          )
        }
        consequence={
          promoting?.mode === 'active'
            ? 'This takes effect immediately. If it behaves unexpectedly, you can roll back to the previous version at any time.'
            : 'Customers will see base prices while this is paused. No rules will be applied.'
        }
        details={
          promoting
            ? [
                { label: 'Strategy', value: promoting.strategy.name },
                { label: 'Version', value: promoting.strategy.version },
                { label: 'Rules', value: number(promoting.strategy.rule_count) },
              ]
            : undefined
        }
        confirmLabel={promoting?.mode === 'active' ? 'Activate' : 'Pause'}
        variant={promoting?.mode === 'active' ? 'primary' : 'dangerSolid'}
        pending={promote.pending}
        error={promote.error}
      />

      {/* ── rollback ─────────────────────────────────────────────────── */}
      <Modal
        open={!!rollingBack}
        onClose={() => {
          setRollingBack(null);
          rollback.reset();
        }}
        title="Roll back to an earlier version"
        subtitle={rollingBack?.name}
        disableOverlayClose
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRollingBack(null);
                rollback.reset();
              }}
              disabled={rollback.pending}
            >
              Cancel
            </Button>
            <Button
              variant="dangerSolid"
              loading={rollback.pending}
              disabled={!rollbackTo}
              onClick={() => {
                if (rollingBack && rollbackTo) {
                  void rollback.run(rollingBack.strategy_id, rollbackTo);
                }
              }}
            >
              Roll back to {rollbackTo || '…'}
            </Button>
          </>
        }
      >
        <Note>
          Rolling back makes an earlier version of this strategy the one serving live prices. The
          newer version is not deleted — you can promote it again later.
        </Note>
        <div style={{ marginTop: 'var(--s-4)' }}>
          <Select
            label="Roll back to"
            value={rollbackTo}
            placeholder="Choose a version"
            options={(rollingBack ? distinctVersions(rollingBack) : [])
              .filter((v) => v !== rollingBack?.version)
              .map((v) => ({ value: v, label: v }))}
            onChange={(e) => setRollbackTo(e.target.value)}
          />
        </div>
        {rollback.error && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <ErrorState error={rollback.error} title="Could not roll back" />
          </div>
        )}
      </Modal>
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Lifecycle actions
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Only the transitions that are legal from the current state.
 *
 * The backend enforces the same order, so offering a promotion it will refuse
 * would be showing a button whose only possible outcome is an error.
 */
function LifecycleActions({
  strategy,
  validating,
  promoting,
  onValidate,
  onPromote,
  onRollback,
}: {
  strategy: Strategy;
  validating: boolean;
  promoting: boolean;
  onValidate: () => void;
  onPromote: (mode: PromoteMode) => void;
  onRollback: () => void;
}) {
  const mode = strategy.mode;
  const canRollback = distinctVersions(strategy).length > 1;

  return (
    <Row>
      {mode === 'draft' && (
        <Button size="sm" variant="primary" icon="shield" loading={validating} onClick={onValidate}>
          Validate
        </Button>
      )}

      {mode === 'validated' && (
        <>
          <Button size="sm" variant="secondary" icon="live" loading={promoting} onClick={() => onPromote('shadow')}>
            Run in shadow
          </Button>
          <Button size="sm" variant="primary" icon="play" loading={promoting} onClick={() => onPromote('active')}>
            Activate
          </Button>
        </>
      )}

      {mode === 'shadow' && (
        <>
          <Button size="sm" variant="primary" icon="play" loading={promoting} onClick={() => onPromote('active')}>
            Activate
          </Button>
          <LinkButton to="/app/simulation" size="sm" variant="ghost">
            Compare against live
          </LinkButton>
        </>
      )}

      {mode === 'active' && (
        <>
          <Button size="sm" variant="danger" icon="pause" loading={promoting} onClick={() => onPromote('paused')}>
            Pause
          </Button>
          {canRollback && (
            <Button size="sm" variant="danger" icon="rollback" onClick={onRollback}>
              Roll back
            </Button>
          )}
        </>
      )}

      {mode === 'paused' && (
        <Button size="sm" variant="primary" icon="play" loading={promoting} onClick={() => onPromote('active')}>
          Resume
        </Button>
      )}

      {/* Validation is always available: re-checking a strategy is free and
          catches a rule that was edited after the strategy was compiled. */}
      {mode !== 'draft' && (
        <Button size="sm" variant="ghost" icon="shield" loading={validating} onClick={onValidate}>
          Re-validate
        </Button>
      )}

      <LinkButton to="/app/simulation" size="sm" variant="ghost" icon="simulation">
        Test
      </LinkButton>
    </Row>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Validation report
   ═══════════════════════════════════════════════════════════════════════ */

function ValidationReport({
  report,
  onDismiss,
}: {
  report: ValidateStrategyResponse;
  onDismiss: () => void;
}) {
  return (
    <Card tone={report.passed ? 'default' : 'critical'}>
      <CardHeader
        title={report.passed ? 'Validation passed' : 'Validation failed'}
        subtitle={report.next_step}
        actions={
          <Row>
            {report.passed ? (
              <Badge tone="success" icon="check">
                {plural(report.rule_count, 'rule')} checked
              </Badge>
            ) : (
              <Badge tone="critical" icon="warning">
                {plural(report.errors.length, 'error')}
              </Badge>
            )}
            <Button size="sm" variant="ghost" icon="close" aria-label="Dismiss" onClick={onDismiss} />
          </Row>
        }
      />
      <CardBody>
        <Stack tight>
          {report.errors.map((e) => (
            <div key={e} style={{ display: 'flex', gap: 'var(--s-2)', fontSize: 'var(--t-sm)' }}>
              <Icon
                name="critical"
                size={14}
                style={{ color: 'var(--critical-text)', flexShrink: 0, marginTop: 2 }}
              />
              {e}
            </div>
          ))}

          {report.warnings.map((w, i) => (
            <div
              key={`${w.type}-${i}`}
              style={{ display: 'flex', gap: 'var(--s-2)', fontSize: 'var(--t-sm)' }}
            >
              <Icon
                name="warning"
                size={14}
                style={{ color: 'var(--warning-text)', flexShrink: 0, marginTop: 2 }}
              />
              <span>
                {w.message}
                {(w.rule_names as string[] | null)?.length ? (
                  <span style={{ display: 'block', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
                    {(w.rule_names as string[]).join(', ')}
                  </span>
                ) : null}
              </span>
            </div>
          ))}

          {report.passed && report.warnings.length === 0 && report.errors.length === 0 && (
            <Note>
              No conflicts, no unreachable rules, and every rule has guardrail coverage. This
              strategy is safe to promote.
            </Note>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Create
   ═══════════════════════════════════════════════════════════════════════ */

function CreateStrategyModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const rules = useAsync((signal) => rulesApi.list(projectId, true, { signal }), [projectId]);

  // Conflicts are checked against the exact set being bundled, not the whole
  // project — so the warning shown is the one that applies to this strategy.
  const conflicts = useAsync(
    (signal) => rulesApi.conflicts(projectId, [...picked], { signal }),
    [projectId, [...picked].sort().join(',')],
    { enabled: picked.size > 1 },
  );

  const create = useMutation(
    () => strategiesApi.create({ project_id: projectId, name: name.trim(), rule_ids: [...picked] }),
    {
      onSuccess: () => {
        toast.success('Strategy created', 'It starts as a draft. Validate it when you are ready.');
        onCreated();
      },
    },
  );

  const available = (rules.data?.rules ?? []).filter((r) => r.enabled);

  return (
    <Modal
      open
      onClose={onClose}
      title="New strategy"
      subtitle="Choose which rules this strategy applies. It starts as a draft and prices nothing until you promote it."
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.pending}
            disabled={!name.trim() || picked.size === 0}
            onClick={() => void create.run()}
          >
            Create draft
          </Button>
        </>
      }
    >
      <Stack>
        <Input
          label="Name"
          autoFocus
          value={name}
          placeholder="Dynamic Demand"
          hint="Something you will recognise in the audit trail six months from now."
          onChange={(e) => setName(e.target.value)}
        />

        {rules.loading ? (
          <Loading label="Loading your rules" inline />
        ) : available.length === 0 ? (
          <EmptyState
            compact
            icon="rules"
            title="No enabled rules"
            body="A strategy needs at least one rule. Create a rule first, then come back."
            action={
              <LinkButton to="/app/rules" variant="primary" size="sm">
                Go to rules
              </LinkButton>
            }
          />
        ) : (
          <div>
            <div style={{ fontSize: 'var(--t-sm)', fontWeight: 500, marginBottom: 'var(--s-3)' }}>
              Rules ({picked.size} selected)
            </div>
            <Stack tight>
              {available.map((r) => (
                <Well key={r.rule_id}>
                  <Checkbox
                    label={
                      <Row>
                        {r.name}
                        <Badge tone="neutral">p{r.priority}</Badge>
                        {r.conflict_group && <Badge tone="info">{r.conflict_group}</Badge>}
                      </Row>
                    }
                    hint={r.explanation}
                    checked={picked.has(r.rule_id)}
                    onChange={(e) => {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(r.rule_id);
                        else next.delete(r.rule_id);
                        return next;
                      });
                    }}
                  />
                </Well>
              ))}
            </Stack>
          </div>
        )}

        {conflicts.data && conflicts.data.conflicts.length > 0 && (
          <Card tone="critical" pad="sm">
            <Row>
              <Icon name="warning" size={16} style={{ color: 'var(--critical-text)' }} />
              <strong style={{ fontSize: 'var(--t-sm)' }}>
                {plural(conflicts.data.conflicts.length, 'conflict')} in this selection
              </strong>
            </Row>
            <Stack tight>
              {conflicts.data.conflicts.map((c, i) => (
                <p
                  key={`${c.type}-${i}`}
                  style={{
                    marginTop: 'var(--s-2)',
                    fontSize: 'var(--t-sm)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {c.message}
                  {c.rule_names.length > 0 && ` (${c.rule_names.join(', ')})`}
                </p>
              ))}
            </Stack>
            <p style={{ marginTop: 'var(--s-3)', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
              You can still create the draft — validation will report these again before it can go
              live.
            </p>
          </Card>
        )}

        {create.error && <ErrorState error={create.error} title="Could not create the strategy" />}
      </Stack>
    </Modal>
  );
}
