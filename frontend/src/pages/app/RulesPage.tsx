import { useMemo, useState } from 'react';
import {
  aiApi,
  projectsApi,
  rulesApi,
  type Adjustment,
  type AdjustmentType,
  type FormulaMode,
  type Clause,
  type Operator,
} from '@/api/endpoints';
import type { AiConfigureResponse, RuleListResponse } from '@/api/types';
import { Note, PageHeader, Row, Stack } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Checkbox, Input, Select, Textarea, type SelectOption } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useAgentSurface } from '@/hooks/useProjectAgent';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { plural } from '@/lib/format';
import s from './Rules.module.css';

/**
 * The rule builder.
 *
 * An analyst never sees JSON here. A rule is composed as a sentence — WHEN
 * occupancy is above 80 AND availability is below 20, THEN increase price by 8%
 * — and the sentence is restated in plain English underneath as it is edited, so
 * the rule can be reviewed by someone who did not write it.
 *
 * The AI assistant drafts rules from a description. It is labelled AI DRAFT and
 * lands in this same editor for a human to check, edit and save. It never writes
 * to the project itself.
 */

type Rule = RuleListResponse['rules'][number];

/** Mirrors core/catalog.py OPERATORS. Phrased as the sentence reads. */
const OPERATORS: readonly { value: Operator; label: string }[] = [
  { value: '>', label: 'is above' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is below' },
  { value: '<=', label: 'is at most' },
  { value: '==', label: 'equals' },
  { value: '!=', label: 'does not equal' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'between', label: 'is between' },
];

const ADJUSTMENTS: readonly { value: AdjustmentType; label: string }[] = [
  { value: 'percentage', label: 'Change by a percentage' },
  { value: 'absolute', label: 'Change by a fixed amount' },
  { value: 'multiplier', label: 'Multiply the base price' },
  { value: 'set_price', label: 'Set an exact price' },
  { value: 'formula', label: 'Compute with a formula' },
];

const FORMULA_MODES: readonly { value: FormulaMode; label: string }[] = [
  { value: 'percent', label: 'as a percentage change' },
  { value: 'amount', label: 'as a fixed amount' },
  { value: 'price', label: 'as the exact price' },
];

/** The operators that take a list rather than a single value. */
const LIST_OPS = new Set<Operator>(['in', 'not_in']);

interface DraftClause {
  field: string;
  op: Operator;
  value: string;
  value2: string;
}

interface DraftRule {
  name: string;
  logic: 'all' | 'any';
  clauses: DraftClause[];
  adjustmentType: AdjustmentType;
  adjustmentValue: string;
  /** type === 'formula' only. */
  formulaExpr: string;
  formulaMode: FormulaMode;
  /** Percentage and absolute adjustments can go either way. */
  direction: 'increase' | 'decrease';
  priority: number;
  stackable: boolean;
  conflictGroup: string;
  enabled: boolean;
  /** Optional calendar window, as datetime-local strings ('' = open-ended). */
  startsAt: string;
  endsAt: string;
}

function emptyDraft(): DraftRule {
  return {
    name: '',
    logic: 'all',
    clauses: [{ field: '', op: '>', value: '', value2: '' }],
    adjustmentType: 'percentage',
    adjustmentValue: '',
    formulaExpr: '',
    formulaMode: 'percent',
    direction: 'increase',
    priority: 50,
    stackable: true,
    conflictGroup: '',
    enabled: true,
    startsAt: '',
    endsAt: '',
  };
}

export default function RulesPage() {
  const { project, projectId } = useSession();
  const toast = useToast();

  const [editing, setEditing] = useState<{ draft: DraftRule; ruleId: string | null } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [showDisabled, setShowDisabled] = useState(true);

  const rules = useAsync(
    (signal) => rulesApi.list(projectId!, true, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const detail = useAsync(
    (signal) => projectsApi.get(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const conflicts = useAsync(
    (signal) => rulesApi.conflicts(projectId!, undefined, { signal }),
    [projectId, rules.data?.count],
    { enabled: !!projectId && (rules.data?.count ?? 0) > 1 },
  );

  // The in-project assistant drops rules here. Each §rule it streams becomes a
  // real rule via the ordinary create endpoint — so it lands in this list,
  // filled in and fully editable, and (like everything created here) does not
  // touch live pricing until a strategy is published. The agent proposes; the
  // user reviews, edits, enables.
  useAgentSurface('rules', (d) => {
    if (!projectId) return null;

    // Delete rules by name (or '*' for all) — this is how the agent cleans up
    // duplicates/conflicts: it REMOVES the extras instead of piling on more.
    if (d.kind === 'rmrule') {
      const all = rules.data?.rules ?? [];
      const targets = d.name === '*'
        ? all
        : all.filter((r) => r.name.trim().toLowerCase() === d.name.trim().toLowerCase());
      if (!targets.length) return null;
      Promise.allSettled(targets.map((r) => rulesApi.remove(projectId, r.rule_id)))
        .then(() => {
          rules.refetch();
          conflicts.refetch();
        })
        .catch(() => { /* surfaced per-item */ });
      return d.name === '*' ? `cleared ${targets.length} rules` : `removed ${d.name}`;
    }

    if (d.kind !== 'rule') return null;
    const conditions = d.clauses.map((c) => {
      const n = Number(c.value);
      return {
        field: c.field,
        operator: c.op as Operator,
        value: c.value !== '' && !Number.isNaN(n) ? n : c.value,
      };
    });
    const pct = d.percent.replace(/[%\s]/g, '');
    const adjustment: Adjustment = {
      type: 'percentage',
      value: Math.abs(Number(pct)) || 0,
      direction: pct.trim().startsWith('-') ? 'decrease' : 'increase',
    };
    rulesApi
      .create({
        project_id: projectId,
        name: d.name,
        conditions,
        adjustment,
        logic: 'all',
        enabled: true,
      })
      .then(() => {
        rules.refetch();
        conflicts.refetch();
      })
      .catch((e) => toast.error('Could not add the rule', String(e)));
    return `+ ${d.name}`;
  });

  /**
   * The fields a rule may reference.
   *
   * Built from the project's own schema plus the built-in signals the server
   * supplies, never a hardcoded list — a co-working project must offer
   * `desk_occupancy`, and the only source of truth for that is the schema.
   */
  const fieldOptions = useMemo<SelectOption[]>(() => {
    const schema = detail.data?.schema;
    const signals = (schema?.context_signals ?? []).map((sig) => ({
      value: sig.id,
      label: `${sig.label} (${sig.id})`,
    }));
    const attributes = (schema?.attributes ?? []).map((a) => ({
      value: a.id,
      label: `${a.label} (${a.id})`,
    }));
    const builtins = (detail.data?.builtin_signals ?? []).map((b) => ({
      value: b.id,
      label: `${b.label} (${b.id})`,
    }));
    return [...signals, ...attributes, ...builtins];
  }, [detail.data]);

  // The dedicated toggle re-syncs the LIVE strategy, so switching a rule off
  // takes effect on the very next price request — not just on the next publish.
  const toggleEnabled = useMutation(
    (ruleId: string, enabled: boolean) => rulesApi.toggle(projectId!, ruleId, enabled),
    {
      onSuccess: (res) => {
        rules.refetch();
        conflicts.refetch();
        toast.success(
          res.enabled ? 'Rule switched on' : 'Rule switched off',
          res.in_active_strategy
            ? 'Live now — the next price request reflects it.'
            : 'Saved; applies when its strategy is next published.',
        );
      },
      onError: (e) => toast.error('Could not switch the rule', e.message),
    },
  );

  const deleteRule = useMutation(
    (ruleId: string) => rulesApi.remove(projectId!, ruleId),
    {
      onSuccess: () => {
        rules.refetch();
        conflicts.refetch();
        toast.success('Rule deleted', 'Removed from the live strategy too.');
      },
      onError: (e) => toast.error('Could not delete the rule', e.message),
    },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="rules"
          title="No project selected"
          body="Create a project before writing pricing rules."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const allRules = rules.data?.rules ?? [];
  const visible = showDisabled ? allRules : allRules.filter((r) => r.enabled);

  return (
    <Stack>
      <PageHeader
        title="Rules"
        description="A rule is one business decision: when these conditions hold, adjust the price this way. Rules do nothing on their own — a strategy bundles them, and guardrails keep them in bounds."
        actions={
          <Row>
            <Checkbox
              label="Show disabled"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
            />
            <Button size="sm" variant="secondary" icon="sparkle" onClick={() => setAiOpen(true)}>
              Describe a rule
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="plus"
              onClick={() => setEditing({ draft: emptyDraft(), ruleId: null })}
            >
              New rule
            </Button>
          </Row>
        }
      />

      {rules.error && <ErrorState error={rules.error} onRetry={rules.refetch} />}

      {/* Conflicts across the whole project, surfaced before a strategy is even
          built — finding them at validation time is late. */}
      {conflicts.data && conflicts.data.conflicts.length > 0 && (
        <Card>
          <CardHeader
            title="Conflicts detected"
            subtitle="These rules interact in ways that will change the price unpredictably."
            actions={
              <Badge tone={conflicts.data.error_count > 0 ? 'critical' : 'warning'}>
                {plural(conflicts.data.conflicts.length, 'conflict')}
              </Badge>
            }
          />
          <CardBody>
            <Stack tight>
              {conflicts.data.conflicts.map((c, i) => (
                <div
                  key={`${c.type}-${i}`}
                  className={cx(
                    s.conflict,
                    c.severity === 'error' ? s.conflictError : s.conflictWarning,
                  )}
                >
                  <Icon
                    name={c.severity === 'error' ? 'critical' : 'warning'}
                    size={15}
                    className={s.conflictIcon}
                    style={{
                      color:
                        c.severity === 'error' ? 'var(--critical-text)' : 'var(--warning-text)',
                    }}
                  />
                  <span>
                    {c.message}
                    {c.rule_names.length > 0 && (
                      <span className={s.conflictRules}>{c.rule_names.join(' · ')}</span>
                    )}
                  </span>
                </div>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}

      {rules.initialLoading ? (
        <Loading label="Loading rules" />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="rules"
            title={allRules.length === 0 ? 'No rules yet' : 'No enabled rules'}
            body={
              allRules.length === 0
                ? 'Start with one decision your team already makes by hand — "put prices up when we are nearly full" — and encode it. You can describe it in plain language and let DevNexus draft it.'
                : 'Every rule in this project is disabled. Enable one, or create a new rule.'
            }
            action={
              <Row>
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => setEditing({ draft: emptyDraft(), ruleId: null })}
                >
                  Create a rule
                </Button>
                <Button variant="secondary" icon="sparkle" onClick={() => setAiOpen(true)}>
                  Describe it instead
                </Button>
              </Row>
            }
          />
        </Card>
      ) : (
        <Stack tight>
          {visible.map((r) => (
            <div key={r.rule_id} className={cx(s.ruleCard, !r.enabled && s.ruleDisabled)}>
              <div>
                <div className={s.ruleTitle}>
                  {r.name}
                  <Badge tone="neutral">priority {r.priority}</Badge>
                  {r.conflict_group && <Badge tone="info">{r.conflict_group}</Badge>}
                  {r.adjustment.type === 'formula' && (
                    <Badge tone="accent" icon="simulation">formula</Badge>
                  )}
                  {(r.starts_at || r.ends_at) && (
                    <Badge tone="info" icon="clock">scheduled</Badge>
                  )}
                  {!r.stackable && (
                    <Badge tone="warning" caps>
                      exclusive
                    </Badge>
                  )}
                  {!r.enabled && (
                    <Badge tone="neutral" caps>
                      disabled
                    </Badge>
                  )}
                  {r.origin === 'ai' && (
                    <Badge tone="accent" caps icon="sparkle">
                      from AI draft
                    </Badge>
                  )}
                </div>

                <p className={s.ruleExplanation}>{r.explanation}</p>

                <div className={s.ruleMeta}>
                  <span>version {r.version}</span>
                  <span>
                    {r.trigger_count > 0 ? `fired ${plural(r.trigger_count, 'time')}` : 'never fired'}
                  </span>
                  <span>{plural(r.clauses.length, 'condition')}</span>
                  <span>matches {r.logic === 'all' ? 'all conditions' : 'any condition'}</span>
                </div>
              </div>

              <div className={s.ruleActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing({ draft: draftFromRule(r), ruleId: r.rule_id })}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  loading={deleteRule.pending}
                  onClick={() => void deleteRule.run(r.rule_id)}
                >
                  Delete
                </Button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.enabled}
                  aria-label={`Rule ${r.enabled ? 'on' : 'off'}`}
                  disabled={toggleEnabled.pending}
                  className={cx(s.ruleSwitch, r.enabled && s.ruleSwitchOn)}
                  onClick={() => void toggleEnabled.run(r.rule_id, !r.enabled)}
                >
                  <span className={s.ruleKnob} />
                </button>
              </div>
            </div>
          ))}
        </Stack>
      )}

      {editing && projectId && (
        <RuleEditor
          projectId={projectId}
          draft={editing.draft}
          ruleId={editing.ruleId}
          fieldOptions={fieldOptions}
          currency={project.currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            rules.refetch();
            conflicts.refetch();
          }}
        />
      )}

      {aiOpen && projectId && (
        <AiDraftModal
          projectId={projectId}
          onClose={() => setAiOpen(false)}
          onAccept={(draft) => {
            setAiOpen(false);
            setEditing({ draft, ruleId: null });
          }}
        />
      )}
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   The editor
   ═══════════════════════════════════════════════════════════════════════ */

function RuleEditor({
  projectId,
  draft: initial,
  ruleId,
  fieldOptions,
  currency,
  onClose,
  onSaved,
}: {
  projectId: string;
  draft: DraftRule;
  ruleId: string | null;
  fieldOptions: readonly SelectOption[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<DraftRule>(initial);

  const update = (patch: Partial<DraftRule>) => setDraft((d) => ({ ...d, ...patch }));

  const updateClause = (index: number, patch: Partial<DraftClause>) =>
    setDraft((d) => ({
      ...d,
      clauses: d.clauses.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));

  // The return is annotated because create and update answer with different
  // shapes (only create reports conflicts). Nothing here reads the body, so the
  // common `{ok, rule_id}` is the honest type rather than asserting one of them.
  const save = useMutation(
    async (): Promise<{ ok: boolean; rule_id: string }> => {
      const clauses = toClauses(draft);
      const adjustment = toAdjustment(draft);
      if (ruleId) {
        return rulesApi.update({
          project_id: projectId,
          rule_id: ruleId,
          name: draft.name.trim(),
          conditions: clauses,
          adjustment,
          logic: draft.logic,
          priority: draft.priority,
          stackable: draft.stackable,
          // An empty conflict group is a deliberate clear, which is why it is
          // sent as '' rather than omitted.
          conflict_group: draft.conflictGroup.trim(),
          enabled: draft.enabled,
          starts_at: toEpoch(draft.startsAt),
          ends_at: toEpoch(draft.endsAt),
          // Both blank on an existing rule means "remove any window".
          clear_window: !draft.startsAt && !draft.endsAt,
        });
      }
      return rulesApi.create({
        project_id: projectId,
        name: draft.name.trim(),
        conditions: clauses,
        adjustment,
        logic: draft.logic,
        priority: draft.priority,
        stackable: draft.stackable,
        conflict_group: draft.conflictGroup.trim() || undefined,
        enabled: draft.enabled,
        starts_at: toEpoch(draft.startsAt),
        ends_at: toEpoch(draft.endsAt),
      });
    },
    {
      onSuccess: () => {
        toast.success(
          ruleId ? 'Rule updated' : 'Rule created',
          ruleId
            ? 'A new version of the rule was saved. Re-validate any strategy that uses it.'
            : 'Add it to a strategy when you are ready to test it.',
        );
        onSaved();
      },
    },
  );

  const valid = isValid(draft);

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title={ruleId ? 'Edit rule' : 'New rule'}
      subtitle={
        ruleId
          ? 'Saving creates a new version of this rule. Strategies using it will need re-validating.'
          : 'Describe when the price should change, and by how much.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.pending}
            disabled={!valid}
            onClick={() => void save.run()}
          >
            {ruleId ? 'Save new version' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className={s.builder}>
        <Input
          label="Rule name"
          autoFocus
          value={draft.name}
          placeholder="High demand premium"
          onChange={(e) => update({ name: e.target.value })}
        />

        {/* ── WHEN ──────────────────────────────────────────────────── */}
        <div className={s.clauseBlock}>
          <div className={s.blockLabel}>
            <span>When</span>
            <Select
              aria-label="Match all or any condition"
              value={draft.logic}
              options={[
                { value: 'all', label: 'all conditions match' },
                { value: 'any', label: 'any condition matches' },
              ]}
              onChange={(e) => update({ logic: e.target.value as 'all' | 'any' })}
              style={{ height: 26, fontSize: 'var(--t-xs)', width: 'auto' }}
            />
          </div>
          <div className={s.blockBody}>
            {draft.clauses.map((clause, i) => (
              <div key={i}>
                {i > 0 && (
                  <div className={s.joiner} style={{ marginBottom: 'var(--s-3)' }}>
                    <span className={s.joinerLine} />
                    {draft.logic === 'all' ? 'and' : 'or'}
                    <span className={s.joinerLine} />
                  </div>
                )}
                <div
                  className={cx(s.clauseRow, clause.op === 'between' && s.clauseRowBetween)}
                >
                  <Select
                    aria-label="Field"
                    value={clause.field}
                    placeholder="Choose a signal"
                    options={fieldOptions}
                    onChange={(e) => updateClause(i, { field: e.target.value })}
                  />
                  <Select
                    aria-label="Operator"
                    value={clause.op}
                    options={OPERATORS}
                    onChange={(e) => updateClause(i, { op: e.target.value as Operator })}
                  />
                  <Input
                    aria-label="Value"
                    type={LIST_OPS.has(clause.op) ? 'text' : 'number'}
                    value={clause.value}
                    placeholder={LIST_OPS.has(clause.op) ? 'SAT, SUN' : '80'}
                    onChange={(e) => updateClause(i, { value: e.target.value })}
                  />
                  {clause.op === 'between' && (
                    <Input
                      aria-label="Upper bound"
                      type="number"
                      value={clause.value2}
                      placeholder="and 95"
                      onChange={(e) => updateClause(i, { value2: e.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    className={s.removeBtn}
                    aria-label="Remove this condition"
                    disabled={draft.clauses.length === 1}
                    onClick={() =>
                      setDraft((d) => ({ ...d, clauses: d.clauses.filter((_, j) => j !== i) }))
                    }
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
            ))}

            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  clauses: [...d.clauses, { field: '', op: '>', value: '', value2: '' }],
                }))
              }
            >
              Add a condition
            </Button>
          </div>
        </div>

        {/* ── THEN ──────────────────────────────────────────────────── */}
        <div className={s.clauseBlock}>
          <div className={s.blockLabel}>Then</div>
          <div className={s.blockBody}>
            <div className={s.clauseRow}>
              <Select
                aria-label="Adjustment type"
                value={draft.adjustmentType}
                options={ADJUSTMENTS}
                onChange={(e) =>
                  update({ adjustmentType: e.target.value as AdjustmentType })
                }
              />
              {/* Direction only applies where it means something: you cannot
                  "decrease" a multiplier or an exact price. */}
              {(draft.adjustmentType === 'percentage' || draft.adjustmentType === 'absolute') && (
                <Select
                  aria-label="Direction"
                  value={draft.direction}
                  options={[
                    { value: 'increase', label: 'increase' },
                    { value: 'decrease', label: 'decrease' },
                  ]}
                  onChange={(e) =>
                    update({ direction: e.target.value as 'increase' | 'decrease' })
                  }
                />
              )}
              {draft.adjustmentType === 'formula' ? (
                <Select
                  aria-label="Apply formula"
                  value={draft.formulaMode}
                  options={FORMULA_MODES}
                  onChange={(e) => update({ formulaMode: e.target.value as FormulaMode })}
                />
              ) : (
                <Input
                  aria-label="Amount"
                  type="number"
                  step="0.01"
                  value={draft.adjustmentValue}
                  suffix={
                    draft.adjustmentType === 'percentage'
                      ? '%'
                      : draft.adjustmentType === 'multiplier'
                        ? '×'
                        : currency
                  }
                  placeholder={draft.adjustmentType === 'multiplier' ? '1.15' : '8'}
                  onChange={(e) => update({ adjustmentValue: e.target.value })}
                />
              )}
            </div>

            {draft.adjustmentType === 'formula' && (
              <div className={s.formulaBox}>
                <Input
                  aria-label="Formula"
                  mono
                  value={draft.formulaExpr}
                  placeholder="base * (1 + 0.5 * demand / 100)"
                  onChange={(e) => update({ formulaExpr: e.target.value })}
                />
                <p className={s.formulaHint}>
                  Arithmetic over your signals plus <code>base</code> and <code>cost</code>. Allowed:
                  {' '}+ − × ÷, and <code>min max abs round floor ceil sqrt clamp lerp</code>.
                  Anything else is rejected when you save.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── the plain-English restatement ─────────────────────────── */}
        <div className={cx(s.sentence, !valid && s.sentenceIncomplete)}>
          {valid ? (
            <>
              <span className={s.sentenceStrong}>{describe(draft, currency)}</span>
            </>
          ) : (
            'Fill in a name, at least one complete condition and an amount, and the rule will be described here in plain English.'
          )}
        </div>

        {/* ── priority and conflicts ────────────────────────────────── */}
        <Row>
          <Input
            label="Priority"
            type="number"
            min={0}
            max={100}
            value={String(draft.priority)}
            hint="Higher wins. Rules are applied highest first."
            onChange={(e) => update({ priority: Number(e.target.value) })}
          />
          <Input
            label="Conflict group"
            optional
            value={draft.conflictGroup}
            placeholder="demand"
            hint="Rules in the same group compete — only the highest priority one applies."
            onChange={(e) => update({ conflictGroup: e.target.value })}
          />
        </Row>

        <Checkbox
          label="Can combine with other rules"
          hint="Turn this off if this rule must be the only one applied when it matches."
          checked={draft.stackable}
          onChange={(e) => update({ stackable: e.target.checked })}
        />

        <Checkbox
          label="Enabled"
          hint="A disabled rule stays configured but is never evaluated."
          checked={draft.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />

        {/* ── active window ─────────────────────────────────────────────
            Optional. A rule with a window only applies between the two dates —
            it turns itself on and off, so a festival or sale rule needs no one
            to remember to activate and pause it. Leave both blank for always. */}
        <div className={s.window}>
          <div className={s.windowHead}>
            <Icon name="clock" size={14} />
            <span>Active window</span>
            <span className={s.windowNote}>optional — leave blank to always apply</span>
          </div>
          <Row>
            <Input
              label="Starts"
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => update({ startsAt: e.target.value })}
            />
            <Input
              label="Ends"
              type="datetime-local"
              value={draft.endsAt}
              error={
                draft.startsAt && draft.endsAt && draft.endsAt <= draft.startsAt
                  ? 'End must be after start.'
                  : null
              }
              onChange={(e) => update({ endsAt: e.target.value })}
            />
          </Row>
        </div>

        {save.error && <ErrorState error={save.error} title="Could not save the rule" />}
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   AI draft
   ═══════════════════════════════════════════════════════════════════════ */

function AiDraftModal({
  projectId,
  onClose,
  onAccept,
}: {
  projectId: string;
  onClose: () => void;
  onAccept: (draft: DraftRule) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<AiConfigureResponse | null>(null);

  const generate = useMutation(() => aiApi.configure(projectId, prompt.trim()), {
    onSuccess: setResult,
  });

  const config = result?.config;

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title="Describe the rule you want"
      subtitle="DevNexus will draft it. Nothing is saved or applied until you review it and press save."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {config && result?.understood ? (
            <Button
              variant="primary"
              iconAfter="arrow-right"
              onClick={() => onAccept(draftFromAi(result))}
            >
              Open in the editor
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="sparkle"
              loading={generate.pending}
              disabled={prompt.trim().length < 10}
              onClick={() => void generate.run()}
            >
              Draft it
            </Button>
          )}
        </>
      }
    >
      <Stack>
        <Textarea
          label="What should happen?"
          autoFocus
          value={prompt}
          rows={3}
          placeholder="Increase room prices by 8% when occupancy is above 80% and availability is below 20%."
          hint="Use the names of your own signals where you can. Plain English is fine."
          onChange={(e) => setPrompt(e.target.value)}
        />

        {generate.pending && <Loading label="Drafting your rule" />}

        {generate.error && <ErrorState error={generate.error} title="Could not draft that" />}

        {result && !result.understood && (
          <Card tone="critical" pad="sm">
            <Row>
              <Icon name="warning" size={16} style={{ color: 'var(--critical-text)' }} />
              <strong style={{ fontSize: 'var(--t-sm)' }}>Not enough to go on</strong>
            </Row>
            <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-sm)', color: 'var(--text-secondary)' }}>
              {result.clarification ??
                'Try naming the signal and the threshold, for example "when occupancy is above 80%".'}
            </p>
            {(result.reasons ?? []).length > 0 && (
              <ul style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
                {result.reasons?.map((r) => <li key={r}>· {r}</li>)}
              </ul>
            )}
          </Card>
        )}

        {result?.understood && config && (
          <div className={s.aiPanel}>
            <div className={s.aiHead}>
              <span className={s.aiLabel}>
                <Icon name="sparkle" size={10} />
                AI draft
              </span>
              <span style={{ fontSize: 'var(--t-sm)', fontWeight: 500 }}>
                {result.suggested_name ?? 'Suggested rule'}
              </span>
              {result.confidence && (
                <Badge tone={result.confidence === 'high' ? 'success' : 'warning'}>
                  {result.confidence} confidence
                </Badge>
              )}
            </div>

            <div className={s.aiBody}>
              <div className={s.aiInterpretation}>
                {(result.interpretation ?? []).map((line) => (
                  <span key={line}>· {line}</span>
                ))}
              </div>

              {(result.inferred ?? []).length > 0 && (
                <div className={s.aiWarning}>
                  <Icon
                    name="info"
                    size={14}
                    style={{ color: 'var(--warning-text)', flexShrink: 0, marginTop: 2 }}
                  />
                  <span>
                    <strong>Assumptions made:</strong>{' '}
                    {(result.inferred ?? []).join('; ')}. Check these before saving.
                  </span>
                </div>
              )}

              {(result.warnings ?? []).length > 0 && (
                <div className={s.aiWarning}>
                  <Icon
                    name="warning"
                    size={14}
                    style={{ color: 'var(--warning-text)', flexShrink: 0, marginTop: 2 }}
                  />
                  <span>{(result.warnings ?? []).join('; ')}</span>
                </div>
              )}

              <div className={s.aiMeta}>
                {result.ai?.model && <span>{result.ai.model}</span>}
                {result.ai?.latency_ms !== undefined && (
                  <span>{Math.round(result.ai.latency_ms)} ms</span>
                )}
                {result.cached && <span>served from cache</span>}
                {result.ai?.repaired && <span>output repaired</span>}
              </div>

              <Note>
                This is a draft only. It is not saved, not validated, and not applied to any
                strategy — open it in the editor to review and save it yourself.
              </Note>
            </div>
          </div>
        )}
      </Stack>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Conversions
   ═══════════════════════════════════════════════════════════════════════ */

function toClauses(draft: DraftRule): Clause[] {
  return draft.clauses
    .filter((c) => c.field && c.value !== '')
    .map((c) => {
      if (LIST_OPS.has(c.op)) {
        return {
          field: c.field,
          operator: c.op,
          // The list goes in `value` itself. Comma-separated input, with
          // numeric-looking entries converted so the engine compares like with
          // like rather than "5" against 5.
          value: c.value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .map((v) => (Number.isNaN(Number(v)) ? v : Number(v))),
        };
      }
      if (c.op === 'between') {
        return {
          field: c.field,
          operator: c.op,
          value: Number(c.value),
          value2: Number(c.value2),
        };
      }
      const asNumber = Number(c.value);
      return {
        field: c.field,
        operator: c.op,
        value: Number.isNaN(asNumber) ? c.value : asNumber,
      };
    });
}

function toAdjustment(draft: DraftRule): Adjustment {
  if (draft.adjustmentType === 'formula') {
    return {
      type: 'formula',
      value: 0,
      direction: 'increase',
      expr: draft.formulaExpr.trim(),
      formula_mode: draft.formulaMode,
    };
  }
  // The magnitude is always positive and the direction travels separately: the
  // server rejects a negative value with "use direction to decrease".
  // `multiplier` and `set_price` have no meaningful direction, so they are
  // always sent as an increase.
  const directional =
    draft.adjustmentType === 'percentage' || draft.adjustmentType === 'absolute';
  return {
    type: draft.adjustmentType,
    value: Math.abs(Number(draft.adjustmentValue)),
    direction: directional ? draft.direction : 'increase',
  };
}

/** datetime-local string → epoch ms, or null when blank. */
function toEpoch(local: string): number | null {
  if (!local) return null;
  const t = new Date(local).getTime();
  return Number.isNaN(t) ? null : t;
}

/** epoch ms → the value a datetime-local input expects (local time, no TZ). */
function fromEpoch(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function draftFromRule(rule: Rule): DraftRule {
  return {
    name: rule.name,
    logic: rule.logic === 'any' ? 'any' : 'all',
    clauses:
      rule.clauses.length > 0
        ? rule.clauses.map((c) => ({
            field: c.field,
            op: (c.operator as Operator) ?? '>',
            value: String(c.value ?? ''),
            value2: c.value2 === null || c.value2 === undefined ? '' : String(c.value2),
          }))
        : [{ field: '', op: '>', value: '', value2: '' }],
    adjustmentType: (rule.adjustment.type as AdjustmentType) ?? 'percentage',
    adjustmentValue: String(Math.abs(rule.adjustment.value)),
    formulaExpr: rule.adjustment.expr ?? '',
    formulaMode: (rule.adjustment.formula_mode as FormulaMode) ?? 'percent',
    // Direction comes from its own field; the stored value is always positive.
    direction: rule.adjustment.direction === 'decrease' ? 'decrease' : 'increase',
    priority: rule.priority,
    stackable: rule.stackable,
    conflictGroup: rule.conflict_group ?? '',
    enabled: rule.enabled,
    startsAt: fromEpoch(rule.starts_at),
    endsAt: fromEpoch(rule.ends_at),
  };
}

function draftFromAi(result: AiConfigureResponse): DraftRule {
  const config = result.config;
  const clauses = (config?.clauses ?? []).map((c) => ({
    field: c.field,
    op: (c.operator as Operator) ?? '>',
    value:
      c.value_list && c.value_list.length > 0
        ? c.value_list.join(', ')
        : String(c.value_number ?? ''),
    value2:
      c.value_number_2 === null || c.value_number_2 === undefined ? '' : String(c.value_number_2),
  }));

  const value = config?.adjustment.value ?? 0;
  return {
    name: result.suggested_name ?? '',
    logic: config?.logic === 'any' ? 'any' : 'all',
    clauses: clauses.length > 0 ? clauses : [{ field: '', op: '>', value: '', value2: '' }],
    adjustmentType: (config?.adjustment.type as AdjustmentType) ?? 'percentage',
    adjustmentValue: String(Math.abs(value)),
    formulaExpr: '',
    formulaMode: 'percent',
    direction: config?.adjustment.direction === 'decrease' ? 'decrease' : 'increase',
    priority: config?.priority ?? 50,
    stackable: config?.stackable ?? true,
    conflictGroup: '',
    // An AI-drafted rule arrives enabled but unsaved; the human decides whether
    // it is ever written at all.
    enabled: true,
    startsAt: '',
    endsAt: '',
  };
}

function isValid(draft: DraftRule): boolean {
  if (!draft.name.trim()) return false;
  if (draft.adjustmentType === 'formula') {
    if (!draft.formulaExpr.trim()) return false;
  } else if (draft.adjustmentValue === '' || Number.isNaN(Number(draft.adjustmentValue))) {
    return false;
  }
  if (draft.startsAt && draft.endsAt && draft.endsAt <= draft.startsAt) return false;
  const complete = draft.clauses.filter(
    (c) => c.field && c.value !== '' && (c.op !== 'between' || c.value2 !== ''),
  );
  return complete.length > 0;
}

/** The plain-English restatement shown under the builder. */
function describe(draft: DraftRule, currency: string): string {
  const parts = draft.clauses
    .filter((c) => c.field && c.value !== '')
    .map((c) => {
      const op = OPERATORS.find((o) => o.value === c.op)?.label ?? c.op;
      if (c.op === 'between') return `${c.field} is between ${c.value} and ${c.value2}`;
      return `${c.field} ${op} ${c.value}`;
    });

  const when = parts.join(draft.logic === 'all' ? ' and ' : ' or ');
  const amount = draft.adjustmentValue;
  const verb = draft.direction === 'decrease' ? 'decrease' : 'increase';

  let then: string;
  switch (draft.adjustmentType) {
    case 'percentage':
      then = `${verb} the price by ${amount}%`;
      break;
    case 'absolute':
      then = `${verb} the price by ${currency} ${amount}`;
      break;
    case 'multiplier':
      then = `multiply the base price by ${amount}`;
      break;
    case 'set_price':
      then = `set the price to ${currency} ${amount}`;
      break;
    case 'formula': {
      const where =
        draft.formulaMode === 'price'
          ? 'set the price to'
          : draft.formulaMode === 'amount'
            ? 'adjust the price by'
            : 'change the price by';
      const unit = draft.formulaMode === 'percent' ? '%' : '';
      then = `${where} ${draft.formulaExpr || '…'}${unit}`;
      break;
    }
  }

  const window =
    draft.startsAt || draft.endsAt
      ? ` (only ${draft.startsAt ? `from ${draft.startsAt.replace('T', ' ')}` : ''}${
          draft.endsAt ? ` until ${draft.endsAt.replace('T', ' ')}` : ''
        })`
      : '';
  return `When ${when}, ${then}${window}.`;
}
