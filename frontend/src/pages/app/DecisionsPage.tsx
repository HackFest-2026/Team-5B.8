import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { decisionsApi } from '@/api/endpoints';
import type { DecisionListResponse, DecisionReplayResponse } from '@/api/types';
import { KeyValues, MainWithSide, Note, Row, Spread, Stack } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CopyButton, InlineCode } from '@/components/ui/Code';
import { Checkbox, SearchInput } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading, SkeletonText } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { Table, type Column } from '@/components/ui/Table';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { clockTime, dateTime, duration, money, ms, number, percent, shortId } from '@/lib/format';
import s from './Decisions.module.css';

/**
 * The Decision Explorer and Decision Replay.
 *
 * This is the trust surface of the product, so it is built to be checked rather
 * than admired:
 *
 *  - every rule the engine considered is listed, including the ones that did not
 *    fire and WHY they did not. "Why didn't my rule apply?" is the question
 *    analysts actually arrive with.
 *  - every clause shows the value it expected against the value it got.
 *  - the signal ages are shown, because a decision made on four-minute-old
 *    context is a different thing from one made on fresh context.
 *  - Verify re-runs the engine on the stored snapshot and compares to the cent.
 */
/**
 * Every decision this project has made, as a section of its dashboard.
 *
 * It was a separate route, but "what prices have we returned, and why" is part
 * of the same story as the charts above it — and splitting the evidence from
 * the summary meant nobody checked the evidence.
 */
export function DecisionsSection() {
  const { project, projectId } = useSession();

  /**
   * The open decision lives in the URL, not in component state.
   *
   * A replay is the thing people send each other — "look at this price" — so it
   * has to survive a copy-paste, a refresh and the back button. Local state made
   * it unshareable and lost it on reload.
   */
  const [params, setParams] = useSearchParams();
  const selected = params.get('decision');
  const setSelected = (id: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('decision', id);
        else next.delete('decision');
        return next;
      },
      // Replace, not push: clicking through ten rows should not bury the page
      // under ten back-button steps.
      { replace: true },
    );
  };

  const [changedOnly, setChangedOnly] = useState(false);
  const [itemFilter, setItemFilter] = useState('');

  const list = useAsync(
    (signal) =>
      decisionsApi.list(
        projectId!,
        { limit: 50, changed_only: changedOnly || undefined, item_id: itemFilter.trim() || undefined },
        { signal },
      ),
    [projectId, changedOnly, itemFilter],
    { enabled: !!projectId },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="decisions"
          title="No project selected"
          body="Create a project to start recording pricing decisions."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  const decisions = list.data?.decisions ?? [];
  const currency = project.currency;

  const columns: readonly Column<DecisionListResponse['decisions'][number]>[] = [
    {
      key: 'ts',
      header: 'Time',
      nowrap: true,
      sortBy: (d) => d.ts,
      sortDescFirst: true,
      render: (d) => (
        <span title={dateTime(d.ts)}>{clockTime(d.ts)}</span>
      ),
    },
    { key: 'item', header: 'Item', sortBy: (d) => d.item_id, render: (d) => d.item_id },
    {
      key: 'from',
      header: 'Was',
      align: 'num',
      muted: true,
      render: (d) => money(d.previous_price, currency),
    },
    {
      key: 'to',
      header: 'Now',
      align: 'num',
      // Sorts on the raw number, not the formatted "₹1,744.39" string — which
      // would put ₹9 above ₹10.
      sortBy: (d) => d.price,
      sortDescFirst: true,
      render: (d) => <strong>{money(d.price, currency)}</strong>,
    },
    {
      key: 'change',
      header: 'Change',
      align: 'num',
      sortBy: (d) => (d.changed ? d.change_pct : null),
      sortDescFirst: true,
      render: (d) =>
        d.changed ? (
          <span className={d.change_pct > 0 ? s.changeUp : s.changeDown}>
            {percent(d.change_pct, { signed: true })}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>held</span>
        ),
    },
    {
      key: 'rules',
      header: 'Rules fired',
      truncate: true,
      muted: true,
      render: (d) => (d.rules_fired.length > 0 ? d.rules_fired.join(', ') : '—'),
    },
    { key: 'version', header: 'Strategy', nowrap: true, muted: true, render: (d) => d.strategy_version },
    {
      key: 'status',
      header: 'Status',
      render: (d) =>
        d.fallback ? (
          <Badge tone="critical" caps>
            fallback
          </Badge>
        ) : d.degraded ? (
          <Badge tone="warning" caps>
            degraded
          </Badge>
        ) : (
          <Badge tone="success" caps>
            normal
          </Badge>
        ),
    },
    {
      key: 'latency',
      header: 'Took',
      align: 'num',
      muted: true,
      sortBy: (d) => d.latency_ms,
      sortDescFirst: true,
      render: (d) => ms(d.latency_ms),
    },
  ];

  return (
    <Stack>
      <Spread>
        <div style={{ fontSize: 'var(--t-sm)', color: 'var(--text-muted)', maxWidth: '58ch' }}>
          Every price this project has returned, and the exact reasoning behind each one. Select
          one to replay it.
        </div>
        <Row>
          <SearchInput
            value={itemFilter}
            onChange={setItemFilter}
            placeholder="Filter by item id"
          />
          <Checkbox
            label="Changes only"
            checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)}
          />
          <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={list.refetch} />
        </Row>
      </Spread>

      {list.error && <ErrorState error={list.error} onRetry={list.refetch} />}

      <MainWithSide>
        <Card>
          <CardHeader
            title="Decision history"
            subtitle={
              decisions.length > 0
                ? `${number(decisions.length)} most recent${changedOnly ? ' price changes' : ' decisions'}`
                : undefined
            }
          />
          {list.initialLoading ? (
            <Loading label="Loading decisions" />
          ) : decisions.length === 0 ? (
            <EmptyState
              icon="decisions"
              title={
                itemFilter || changedOnly ? 'Nothing matches those filters' : 'No decisions yet'
              }
              body={
                itemFilter || changedOnly
                  ? 'Try clearing the filters, or widen what you are looking for.'
                  : 'A decision is recorded every time your application asks for a price. Call the pricing API to see the first one.'
              }
              action={
                itemFilter || changedOnly ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setItemFilter('');
                      setChangedOnly(false);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <LinkButton to="/app/api" variant="primary">
                    View the pricing API
                  </LinkButton>
                )
              }
            />
          ) : (
            <Table
              caption="Pricing decisions"
              columns={columns}
              rows={decisions}
              rowKey={(d) => d.decision_id}
              defaultSort="ts"
              selectedKey={selected}
              onRowClick={(d) => setSelected(d.decision_id)}
              footer={
                <>
                  <span>
                    Showing {number(decisions.length)}
                    {list.data?.cursor ? ' — older decisions are available' : ''}
                  </span>
                  <span>Select a row to see why that price happened</span>
                </>
              }
            />
          )}
        </Card>

        {selected ? (
          <ReplayPanel
            projectId={projectId!}
            decisionId={selected}
            onClose={() => setSelected(null)}
          />
        ) : (
          <Card>
            <CardHeader title="Decision replay" />
            <CardBody>
              <Note>
                Select any decision to reconstruct it: the context it used, every rule it
                considered, which guardrails applied, and the final price.
              </Note>
              <div style={{ marginTop: 'var(--s-4)' }}>
                <Note>
                  You can also verify it — DevNexus re-runs the engine against the stored snapshot
                  and checks the price matches to the cent.
                </Note>
              </div>
            </CardBody>
          </Card>
        )}
      </MainWithSide>
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Replay
   ═══════════════════════════════════════════════════════════════════════ */

function ReplayPanel({
  projectId,
  decisionId,
  onClose,
}: {
  projectId: string;
  decisionId: string;
  onClose: () => void;
}) {
  /**
   * Decisions are persisted asynchronously (5-20s, measured), so a decision
   * selected straight off the live feed genuinely is not readable yet.
   *
   * Polling while it is missing turns a confusing 404 into an honest "being
   * recorded" state. The poll is deliberately OFF once the decision arrives:
   * a persisted decision is immutable, so there is nothing to keep refetching.
   */
  const replay = useAsync(
    (signal) => decisionsApi.replay(projectId, decisionId, { signal }),
    [projectId, decisionId],
    { pollMs: 2500 },
  );

  // Treat "not there yet" separately from a real failure. Both arrive as 404,
  // and the distinction is what stops the UI calling a timing lag a bug.
  const notYetRecorded =
    !replay.data &&
    replay.error?.status === 404 &&
    (replay.error.code === 'not_ready' || replay.error.code === 'not_found');

  const shareUrl = `${window.location.origin}${window.location.pathname}?decision=${encodeURIComponent(decisionId)}`;
  // One line per command, not wrapped with shell continuations — a pasted
  // multi-line cURL breaks the moment a terminal mangles a trailing backslash.
  const base = import.meta.env.VITE_API_BASE;
  const query = `project_id=${projectId}&decision_id=${decisionId}`;
  const curl = [
    '# Replace $DEVNEXUS_TOKEN with your session token.',
    '# The token is NOT embedded here, so this is safe to share.',
    '',
    '# Why this price happened:',
    `curl -s "${base}/decisions/replay?token=$DEVNEXUS_TOKEN&${query}"`,
    '',
    '# Prove it reproduces to the cent:',
    `curl -s "${base}/decisions/verify?token=$DEVNEXUS_TOKEN&${query}"`,
  ].join('\n');

  const [verifying, setVerifying] = useState(false);
  const verify = useAsync(
    (signal) => decisionsApi.verify(projectId, decisionId, { signal }),
    [projectId, decisionId, verifying],
    { enabled: verifying },
  );

  const d = replay.data;

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Decision replay"
          subtitle={<InlineCode value={decisionId} display={shortId(decisionId, 8)} />}
          actions={
            <Row>
              <CopyButton value={shareUrl} label="Link" />
              {/* The exact request, ready to paste into a terminal. The token is
                  deliberately left as a placeholder rather than embedded — a
                  shared cURL must not carry a live session. */}
              <CopyButton value={curl} label="cURL" />
              <Button size="sm" variant="ghost" icon="close" aria-label="Close" onClick={onClose} />
            </Row>
          }
        />
        <CardBody>
          {replay.initialLoading ? (
            <SkeletonText lines={5} />
          ) : notYetRecorded ? (
            <Stack>
              <Loading label="This decision is still being recorded" />
              <Note>
                The price was returned instantly, but the full decision record is written by a
                background worker — usually within 5 seconds, sometimes up to 20. This panel will
                fill in by itself.
              </Note>
            </Stack>
          ) : replay.error ? (
            <ErrorState error={replay.error} onRetry={replay.refetch} />
          ) : d ? (
            <Stack>
              <div className={s.priceHeadline}>
                <span className={s.priceMain}>{money(d.price.final, d.price.currency)}</span>
                {d.price.changed && (
                  <span className={s.priceFrom}>
                    from {money(readPrevious(d), d.price.currency)}{' '}
                    <span className={d.price.change_pct > 0 ? s.changeUp : s.changeDown}>
                      {percent(d.price.change_pct, { signed: true })}
                    </span>
                  </span>
                )}
              </div>

              {d.explanation && <div className={s.explanation}>{d.explanation}</div>}

              <KeyValues
                rows={[
                  { key: 'Item', value: d.item_id },
                  { key: 'Base price', value: money(d.price.base, d.price.currency) },
                  {
                    key: 'Rules wanted',
                    value: money(d.price.recommended_before_guardrails, d.price.currency),
                  },
                  { key: 'Charged', value: <strong>{money(d.price.final, d.price.currency)}</strong> },
                  { key: 'Strategy', value: `${d.strategy.version} · ruleset ${d.strategy.ruleset_version}` },
                  { key: 'Evaluated', value: dateTime(d.context_used.evaluated_at_ms) },
                  {
                    key: 'Ran on',
                    value: d.fallback ? (
                      <Badge tone="critical">Fallback — engine did not run</Badge>
                    ) : d.degraded ? (
                      <Badge tone="warning">Stale or partial context</Badge>
                    ) : (
                      <Badge tone="success">Fresh context</Badge>
                    ),
                  },
                ]}
              />

              {d.notes.length > 0 && (
                <div className={s.notes}>
                  {d.notes.map((n) => (
                    <span key={n}>· {n}</span>
                  ))}
                </div>
              )}
            </Stack>
          ) : null}
        </CardBody>
      </Card>

      {/* ── verification ─────────────────────────────────────────────── */}
      {d && (
        <Card>
          <CardHeader
            title="Verify this decision"
            subtitle="Re-runs the engine against the stored snapshot and compares the result."
          />
          <CardBody>
            {!verifying ? (
              <>
                <Note>
                  If the engine is deterministic, replaying this decision must produce the same
                  price to the cent — and the same rules, in the same order.
                </Note>
                <div style={{ marginTop: 'var(--s-4)' }}>
                  <Button variant="primary" icon="shield" onClick={() => setVerifying(true)}>
                    Verify decision
                  </Button>
                </div>
              </>
            ) : verify.loading ? (
              <Loading label="Re-running the engine on the stored snapshot" />
            ) : verify.error ? (
              <ErrorState error={verify.error} onRetry={verify.refetch} />
            ) : verify.data ? (
              <VerifyResult result={verify.data} />
            ) : null}
          </CardBody>
        </Card>
      )}

      {/* ── rules ────────────────────────────────────────────────────── */}
      {d && (
        <Card>
          <CardHeader
            title="Rules evaluated"
            subtitle="Every rule the engine considered, in the order it considered them."
            actions={
              <Badge tone="neutral">
                {number(d.rules.filter((r) => r.applied).length)} of {number(d.rules.length)} applied
              </Badge>
            }
          />
          <CardBody tight>
            {d.rules.length === 0 ? (
              <EmptyState
                compact
                icon="rules"
                title="No rules in this strategy"
                body="The price is the base price because the active strategy has no rules to apply."
              />
            ) : (
              <div className={s.ruleList}>
                {d.rules.map((r) => (
                  <RuleRow key={r.rule_id} rule={r} currency={d.price.currency} />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ── guardrails ───────────────────────────────────────────────── */}
      {d && (
        <Card>
          <CardHeader
            title="Guardrails"
            subtitle={
              d.guardrails.applied.length > 0
                ? 'A limit was reached, so the price the rules asked for was clamped.'
                : 'The price stayed inside every configured limit.'
            }
            actions={
              d.guardrails.applied.length > 0 ? (
                <Badge tone="warning" icon="shield">
                  Clamped
                </Badge>
              ) : (
                <Badge tone="success" icon="shield">
                  Passed
                </Badge>
              )
            }
          />
          <CardBody>
            <Stack tight>
              {(d.guardrails.applied as GuardHit[]).map((g, i) => (
                <div className={s.guardHit} key={`${g.rule}-${i}`}>
                  <span>
                    <strong>{humaniseGuard(g.rule)}</strong>
                    <span style={{ display: 'block', fontSize: 'var(--t-xs)', color: 'var(--text-muted)' }}>
                      limit {String(g.limit)}
                    </span>
                  </span>
                  <span className={s.guardArrow}>
                    {money(g.before, d.price.currency)} → {money(g.after, d.price.currency)}
                  </span>
                </div>
              ))}

              <div style={{ marginTop: d.guardrails.applied.length > 0 ? 'var(--s-3)' : 0 }}>
                <KeyValues
                  rows={Object.entries(d.guardrails.configured)
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([k, v]) => ({
                      key: humaniseGuard(k),
                      value: k.endsWith('_pct') ? `${v}%` : money(v as number, d.price.currency),
                    }))}
                />
              </div>
            </Stack>
          </CardBody>
        </Card>
      )}

      {/* ── context ──────────────────────────────────────────────────── */}
      {d && (
        <Card>
          <CardHeader
            title="Context used"
            subtitle="The exact signal values this decision was evaluated against."
          />
          <CardBody>
            <div className={s.signalTable}>
              {Object.entries(d.context_used.signals).map(([k, v]) => {
                const age = d.context_used.signal_age_seconds[k];
                // 60s matches the engine's own freshness precondition, so a row
                // flagged here is one the engine would also treat as stale.
                const stale = age !== undefined && age > 60;
                return (
                  <div key={k} style={{ display: 'contents' }}>
                    <span className={s.signalKey} title={k}>
                      {k}
                    </span>
                    <span className={s.signalVal}>{formatSignal(v)}</span>
                    <span className={cx(s.signalAge, stale && s.ageStale)}>
                      {age === undefined ? '—' : duration(age)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Pieces
   ═══════════════════════════════════════════════════════════════════════ */

type ReplayRule = DecisionReplayResponse['rules'][number];
interface GuardHit {
  rule: string;
  limit: number | string;
  before: number;
  after: number;
}

function RuleRow({ rule, currency }: { rule: ReplayRule; currency: string }) {
  const [open, setOpen] = useState(false);
  const hasClauses = (rule.clause_results ?? []).length > 0;

  const why = rule.applied
    ? rule.impact_label
    : rule.suppressed_by
      ? `Suppressed by ${rule.suppressed_by}`
      : (rule.skipped_reason ?? (rule.matched ? 'Matched but not applied' : 'Conditions not met'));

  return (
    <div className={cx(s.rule, rule.applied && s.ruleApplied)}>
      <button
        type="button"
        className={cx(s.ruleHead, hasClauses && s.ruleToggle)}
        onClick={hasClauses ? () => setOpen((v) => !v) : undefined}
        aria-expanded={hasClauses ? open : undefined}
        // Without clauses there is nothing to expand, so it should not look or
        // behave like a control.
        tabIndex={hasClauses ? 0 : -1}
      >
        <span
          className={cx(
            s.ruleState,
            rule.applied ? s.stateApplied : rule.matched ? s.stateMatched : s.stateSkipped,
          )}
        >
          <Icon
            name={rule.applied ? 'check' : rule.matched ? 'warning' : 'close'}
            size={13}
            strokeWidth={rule.applied ? 2.6 : 1.8}
          />
        </span>
        <span className={s.ruleName}>
          {rule.name}
          <span className={s.ruleWhy}>{why}</span>
        </span>
        <span className={s.ruleImpact}>
          {rule.applied && rule.impact_amount !== 0
            ? `${rule.impact_amount > 0 ? '+' : ''}${money(rule.impact_amount, currency)}`
            : ''}
        </span>
        <span className={s.rulePriority}>
          p{rule.priority}
          {hasClauses && (
            <Icon
              name={open ? 'chevron-down' : 'chevron-right'}
              size={12}
              style={{ display: 'inline', marginLeft: 4, verticalAlign: 'middle' }}
            />
          )}
        </span>
      </button>

      {open && hasClauses && (
        <div className={s.clauses}>
          {rule.clause_results.map((c, i) => (
            <div className={s.clause} key={`${c.field}-${i}`}>
              <span className={c.matched ? s.clauseMatched : s.clauseFailed}>
                <Icon name={c.matched ? 'check' : 'close'} size={11} strokeWidth={2.4} />
              </span>
              <span className={s.clauseText}>
                {c.field} {c.operator} {String(c.expected)} — got{' '}
                <span className={s.actual}>{String(c.actual)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VerifyResult({ result }: { result: import('@/api/types').DecisionVerifyResponse }) {
  const pass = result.deterministic && result.price.matches;
  return (
    <div className={cx(s.verify, pass ? s.verifyPass : s.verifyFail)}>
      <div className={s.verifyGrid}>
        <div className={s.verifyCell}>
          <span className={s.verifyLabel}>Original</span>
          <span className={s.verifyValue}>{result.price.original.toFixed(2)}</span>
        </div>
        <div className={s.verifyCell}>
          <span className={s.verifyLabel}>Recomputed</span>
          <span className={s.verifyValue}>{result.price.recomputed.toFixed(2)}</span>
        </div>
        <div className={s.verifyCell}>
          <span className={s.verifyLabel}>Difference</span>
          <span className={s.verifyValue}>{result.price.difference.toFixed(2)}</span>
        </div>
        <div className={s.verifyCell}>
          <span className={s.verifyLabel}>Deterministic</span>
          <span className={s.verifyValue}>
            {pass ? (
              <Badge tone="success" icon="check">
                Verified
              </Badge>
            ) : (
              <Badge tone="critical" icon="warning">
                Mismatch
              </Badge>
            )}
          </span>
        </div>
      </div>

      <div className={s.verifyConclusion}>{result.conclusion}</div>

      {!result.rules_applied.matches && (
        <div className={s.verifyConclusion}>
          <strong>Rules differ.</strong> Originally {result.rules_applied.original.join(', ') || 'none'};
          on replay {result.rules_applied.recomputed.join(', ') || 'none'}.
        </div>
      )}
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * `price.previous` comes back as an open record rather than a number in the
 * captured responses, so it is read defensively instead of being cast.
 */
function readPrevious(d: DecisionReplayResponse): number | null {
  const prev = d.price.previous;
  if (typeof prev === 'number') return prev;
  if (prev && typeof prev === 'object') {
    const value = (prev as Record<string, unknown>)['value'];
    if (typeof value === 'number') return value;
  }
  // Reconstruct it from the change we do know, rather than showing nothing.
  if (d.price.change_pct !== 0) {
    return d.price.final / (1 + d.price.change_pct / 100);
  }
  return null;
}

function formatSignal(v: number | string | boolean): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? number(v) : v.toFixed(2);
  }
  return String(v);
}

function humaniseGuard(key: string): string {
  const map: Record<string, string> = {
    min_price: 'Minimum price',
    max_price: 'Maximum price',
    max_increase_pct: 'Maximum increase',
    max_decrease_pct: 'Maximum decrease',
    min_margin_pct: 'Minimum margin',
  };
  return map[key] ?? key.replace(/_/g, ' ');
}
