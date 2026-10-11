import { useMemo, useRef, useState } from 'react';
import { aiApi, itemsApi, projectsApi, simulateApi } from '@/api/endpoints';
import type { AiTestcase } from '@/api/types';
import { PageHeader, Row, Stack, Well } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useAgentSurface } from '@/hooks/useProjectAgent';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import s from './Playground.module.css';

/**
 * The Playground: test your pricing on real configuration, safely.
 *
 * Every run goes through `/simulate/whatif`, which executes the PRODUCTION
 * engine against the real strategy, products and rules — but writes nothing: no
 * decision records, no analytics movement, no events. So it is faithful ("real
 * data") and harmless ("not live"), and it works before you ever switch pricing
 * on. Because the inputs are fixed, the same case always returns the same price,
 * which is exactly why there is no "rerun".
 *
 * An AI-generated case's expected price is a HYPOTHESIS. We run the engine and
 * show expected-vs-actual; a mismatch is flagged for you to judge — it may be
 * the engine, or the AI's arithmetic. The engine is the source of truth.
 */

type CaseStatus = 'idle' | 'running' | 'match' | 'mismatch' | 'ran' | 'error';

interface RunCase extends AiTestcase {
  status: CaseStatus;
  actual?: number | null;
  drivers?: { factor: string; impact: string }[];
  error?: string;
}

interface TestSuite {
  id: string;
  title: string;
  subtitle?: string;
  source: 'ai' | 'manual';
  cases: RunCase[];
  collapsed: boolean;
  started: boolean;
}

export default function PlaygroundPage() {
  const { project, projectId } = useSession();
  const toast = useToast();

  const detail = useAsync(
    (signal) => projectsApi.get(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );
  const items = useAsync(
    (signal) => itemsApi.list(projectId!, {}, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [showManual, setShowManual] = useState(false);

  // Field id → type, so a case's string values coerce correctly before the run.
  const fieldType = useMemo(() => {
    const m: Record<string, string> = {};
    for (const sg of detail.data?.schema?.context_signals ?? []) m[sg.id] = sg.type ?? 'number';
    return m;
  }, [detail.data]);

  const currency = project?.currency ?? 'INR';
  const itemList = items.data?.items ?? [];

  /* ── generate a suite with the AI ──────────────────────────────────── */
  const generate = useMutation(
    () => aiApi.testcases(projectId!, 10),
    {
      onSuccess: (res) => {
        const cases: RunCase[] = res.cases.map((c) => ({ ...c, status: 'idle' }));
        setSuites((prev) => [
          {
            id: `ai-${Date.now()}`,
            title: 'AI test battery',
            subtitle: `${cases.length} cases from your schema · ${res.model}`,
            source: 'ai',
            cases,
            collapsed: false,
            started: false,
          },
          ...prev,
        ]);
        toast.success(`${cases.length} cases generated`, 'Run them to see expected vs actual.');
      },
      onError: (e) => toast.error('Could not generate cases', e.message),
    },
  );

  /* ── run one suite, case by case ───────────────────────────────────── */
  const runningRef = useRef<Set<string>>(new Set());

  const runSuite = async (suiteId: string) => {
    if (runningRef.current.has(suiteId)) return;
    runningRef.current.add(suiteId);
    setSuites((p) => p.map((s) => (s.id === suiteId ? { ...s, started: true, collapsed: false } : s)));

    const suite = suites.find((s) => s.id === suiteId);
    if (!suite) return;

    for (const tc of suite.cases) {
      setSuites((p) =>
        p.map((s) =>
          s.id !== suiteId
            ? s
            : { ...s, cases: s.cases.map((c) => (c.id === tc.id ? { ...c, status: 'running' } : c)) },
        ),
      );
      // A beat so each case reads as a step, not a flash.
      await new Promise((r) => setTimeout(r, 320));

      const overrides: Record<string, number | string> = {};
      for (const [f, v] of Object.entries(tc.signals)) {
        overrides[f] = fieldType[f] === 'number' ? Number(v) : String(v);
      }

      let next: Partial<RunCase>;
      try {
        const res = await simulateApi.whatIf({
          project_id: projectId!,
          item_id: tc.item_id,
          overrides,
        });
        const actual = res.simulated.price;
        const drivers = (res.simulated.drivers ?? []).map((d) => ({
          factor: String(d.factor),
          impact: String(d.impact),
        }));
        // We no longer mark a case match/mismatch against the AI's predicted
        // price — the AI can miscalculate where the engine is right. A case
        // simply RAN: we show the engine's real price and which rules fired, so
        // the user judges whether the engine behaves as intended.
        next = { status: 'ran', actual, drivers };
      } catch (e) {
        next = { status: 'error', error: e instanceof Error ? e.message : 'failed' };
      }

      setSuites((p) =>
        p.map((s) =>
          s.id !== suiteId
            ? s
            : { ...s, cases: s.cases.map((c) => (c.id === tc.id ? { ...c, ...next } : c)) },
        ),
      );
    }
    runningRef.current.delete(suiteId);
  };

  const removeSuite = (id: string) =>
    setSuites((p) => p.filter((s) => s.id !== id));
  const toggleCollapse = (id: string) =>
    setSuites((p) => p.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)));

  const addManual = (tc: RunCase) =>
    setSuites((prev) => [
      {
        id: `manual-${Date.now()}`,
        title: tc.title || 'Manual test',
        source: 'manual',
        cases: [tc],
        collapsed: false,
        started: false,
      },
      ...prev,
    ]);

  // The assistant drops test cases here. They gather into one "Assistant" suite
  // the user can run like any other — expected price is the agent's HYPOTHESIS,
  // the engine stays the source of truth. Nothing here touches live pricing.
  useAgentSurface('playground', (d) => {
    if (d.kind !== 'testcase') return null;
    const signals: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(d.signals)) {
      const n = Number(v);
      signals[k] = fieldType[k] === 'number' && !Number.isNaN(n) ? n : v;
    }
    const tc: RunCase = {
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: d.title,
      description: '',
      item_id: d.itemId,
      signals,
      expected_price: d.expected && !Number.isNaN(Number(d.expected)) ? Number(d.expected) : null,
      reasoning: 'Proposed by the assistant.',
      source: 'ai',
      status: 'idle',
    };
    setSuites((prev) => {
      const existing = prev.find((su) => su.id === 'assistant-cases');
      if (existing) {
        return prev.map((su) =>
          su.id === 'assistant-cases'
            ? { ...su, cases: [...su.cases, tc], collapsed: false }
            : su,
        );
      }
      return [
        {
          id: 'assistant-cases',
          title: 'Assistant test cases',
          source: 'ai',
          cases: [tc],
          collapsed: false,
          started: false,
        },
        ...prev,
      ];
    });
    return `+ test: ${d.title}`;
  });

  if (!project) {
    return (
      <Stack>
        <PageHeader title="Playground" description="Open a project to test its pricing." />
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        title="Playground"
        description="Test your pricing on your real setup — rules, products, guardrails. It runs the real engine but changes nothing: no live prices, no analytics, no history."
        actions={
          <Row>
            <Button
              variant="primary"
              icon="sparkle"
              loading={generate.pending}
              disabled={itemList.length === 0}
              onClick={() => void generate.run()}
            >
              Generate tests
            </Button>
            <Button variant="secondary" icon="plus" onClick={() => setShowManual((v) => !v)}>
              Add a test
            </Button>
          </Row>
        }
      />

      <Well>
        <Row>
          <Icon name="shield" size={15} style={{ color: 'var(--accent)' }} />
          <strong style={{ fontSize: 'var(--t-sm)' }}>Safe by design</strong>
        </Row>
        <p className={s.safe}>
          Every run uses <strong>simulation</strong> — the production engine on your real
          configuration, with <strong>zero side effects</strong>. Each case shows the{' '}
          <strong>engine's real price</strong> and which rules fired, so you can confirm your
          pricing behaves as intended. (Any AI estimate is shown faint, as a reference only.)
        </p>
      </Well>

      {showManual && (
        <ManualForm
          items={itemList}
          fields={detail.data?.schema?.context_signals ?? []}
          currency={currency}
          onAdd={(tc) => {
            addManual(tc);
            setShowManual(false);
          }}
          onCancel={() => setShowManual(false)}
        />
      )}

      {generate.error && <ErrorState error={generate.error} title="Generation failed" />}

      {itemList.length === 0 ? (
        <EmptyState
          icon="projects"
          title="Add a product first"
          body="The Playground builds tests from your products and rules. Add at least one product to begin."
          action={
            <LinkButton to="/app/items" variant="primary" icon="plus">
              Add a product
            </LinkButton>
          }
        />
      ) : suites.length === 0 ? (
        <EmptyState
          icon="simulation"
          title="No tests yet"
          body="Generate a battery of cases from your schema, or add one yourself. Nothing you do here touches live pricing."
        />
      ) : (
        <div className={s.suites}>
          {suites.map((suite) => (
            <SuiteCard
              key={suite.id}
              suite={suite}
              currency={currency}
              onRun={() => void runSuite(suite.id)}
              onCollapse={() => toggleCollapse(suite.id)}
              onRemove={() => removeSuite(suite.id)}
            />
          ))}
        </div>
      )}
    </Stack>
  );
}

/* ── one test / suite card ───────────────────────────────────────────── */

function SuiteCard({
  suite,
  currency,
  onRun,
  onCollapse,
  onRemove,
}: {
  suite: TestSuite;
  currency: string;
  onRun: () => void;
  onCollapse: () => void;
  onRemove: () => void;
}) {
  const ran = suite.cases.filter((c) => c.status !== 'idle' && c.status !== 'running');
  const errored = suite.cases.filter((c) => c.status === 'error').length;
  const priced = ran.length - errored;
  const running = suite.cases.some((c) => c.status === 'running');
  const done = suite.started && !running && ran.length === suite.cases.length;
  const multi = suite.cases.length > 1;

  return (
    <section className={cx(s.suite, done && s.suiteDone)}>
      <header className={s.suiteHead}>
        <button type="button" className={s.suiteTitle} onClick={onCollapse} aria-expanded={!suite.collapsed}>
          <Icon
            name="chevron-down"
            size={15}
            className={cx(s.chev, suite.collapsed && s.chevCollapsed)}
          />
          <span>
            <span className={s.suiteName}>
              {suite.title}
              {suite.source === 'ai' && <Badge tone="accent" caps>AI</Badge>}
            </span>
            {suite.subtitle && <span className={s.suiteSub}>{suite.subtitle}</span>}
          </span>
        </button>

        <div className={s.suiteActions}>
          {done ? (
            <span className={s.scoreRow}>
              {priced > 0 && (
                <span className={cx(s.score, s.scoreOk)}>
                  <Icon name="check" size={12} /> {priced} priced
                </span>
              )}
              {errored > 0 && <span className={cx(s.score, s.scoreBad)}>{errored} errored</span>}
            </span>
          ) : running ? (
            <span className={s.runningTag}>
              <Icon name="spinner" size={13} /> running…
            </span>
          ) : (
            <Button size="sm" variant="primary" icon="play" onClick={onRun}>
              Run {multi ? `${suite.cases.length} tests` : 'test'}
            </Button>
          )}
          <button type="button" className={s.remove} aria-label="Remove" onClick={onRemove}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      {!suite.collapsed && (
        <div className={s.caseList}>
          {suite.cases.map((c) => (
            <CaseRow key={c.id} c={c} currency={currency} />
          ))}
        </div>
      )}

      {done && !suite.collapsed && (
        <div className={s.suiteFoot}>
          <Button size="sm" variant="ghost" icon="check" onClick={onCollapse}>
            Done — collapse
          </Button>
        </div>
      )}
    </section>
  );
}

function CaseRow({ c, currency }: { c: RunCase; currency: string }) {
  const signalBits = Object.entries(c.signals);
  return (
    <div className={cx(s.case, s[`case_${c.status}`])}>
      <div className={s.caseMark}>
        {c.status === 'running' ? (
          <Icon name="spinner" size={13} />
        ) : c.status === 'error' ? (
          <Icon name="warning" size={13} />
        ) : c.actual != null ? (
          <Icon name="check" size={13} strokeWidth={3} />
        ) : (
          <span className={s.caseDot} />
        )}
      </div>

      <div className={s.caseBody}>
        <div className={s.caseTitle}>{c.title}</div>
        {c.description && <div className={s.caseDesc}>{c.description}</div>}
        <div className={s.caseInputs}>
          <span className={s.caseItem}>{c.item_id}</span>
          {signalBits.map(([f, v]) => (
            <span key={f} className={s.chip}>
              {f}={String(v)}
            </span>
          ))}
          {signalBits.length === 0 && <span className={s.chipMuted}>baseline — no signals</span>}
        </div>
        {c.status === 'error' && <div className={s.caseErr}>{c.error}</div>}
      </div>

      <div className={s.caseResult}>
        {c.actual != null && (
          <div className={s.resLine}>
            <span className={s.resLabel}>engine price</span>
            <span className={cx(s.resVal, s.resActual)}>{money(c.actual, currency)}</span>
          </div>
        )}
        {c.actual != null && c.drivers && (
          <div className={s.resDrivers}>
            {(() => {
              const fired = c.drivers
                .map((d) => d.factor)
                .filter((f) => f && f !== 'base' && f !== 'safe_fallback');
              return fired.length ? `rules fired: ${fired.join(', ')}` : 'no rule fired — base price';
            })()}
          </div>
        )}
        {c.expected_price != null && (
          <div className={s.resLine}>
            <span className={s.resLabel}>AI guess</span>
            <span className={cx(s.resVal, s.resValMuted)}>{money(c.expected_price, currency)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── manual / described test ─────────────────────────────────────────── */

function ManualForm({
  items,
  fields,
  currency,
  onAdd,
  onCancel,
}: {
  items: { item_id: string; name: string }[];
  fields: { id: string; label: string; type: string; scope?: string }[];
  currency: string;
  onAdd: (tc: RunCase) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [itemId, setItemId] = useState(items[0]?.item_id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState('');

  const add = () => {
    const signals: Record<string, number | string> = {};
    for (const f of fields) {
      const raw = (values[f.id] ?? '').trim();
      if (raw === '') continue;
      signals[f.id] = f.type === 'number' ? Number(raw) : raw;
    }
    onAdd({
      id: `m-${Date.now()}`,
      title: title.trim() || 'Manual test',
      description: '',
      item_id: itemId,
      signals,
      expected_price: expected.trim() === '' ? null : Number(expected),
      reasoning: '',
      source: 'manual',
      status: 'idle',
    });
  };

  return (
    <div className={s.manual}>
      <div className={s.manualHead}>
        <Icon name="plus" size={14} />
        <span>New test</span>
      </div>
      <Row>
        <Input label="Title" value={title} placeholder="VIP on a scarce item"
          onChange={(e) => setTitle(e.target.value)} />
        <Select label="Product" value={itemId} options={items.map((i) => ({ value: i.item_id, label: `${i.name} (${i.item_id})` }))}
          onChange={(e) => setItemId(e.target.value)} />
        <Input label="Expected price" optional type="number" prefix={currency} value={expected}
          hint="Leave blank to just observe"
          onChange={(e) => setExpected(e.target.value)} />
      </Row>
      <div className={s.manualFields}>
        {fields.map((f) => (
          <Input
            key={f.id}
            label={f.label}
            optional
            type={f.type === 'number' ? 'number' : 'text'}
            value={values[f.id] ?? ''}
            hint={f.scope && f.scope !== 'item' ? f.scope : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
          />
        ))}
      </div>
      <Row>
        <Button variant="primary" icon="plus" disabled={!itemId} onClick={add}>
          Add test
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </Row>
    </div>
  );
}
