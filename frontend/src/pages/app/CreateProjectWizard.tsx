import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  aiApi,
  itemsApi,
  projectsApi,
  rulesApi,
  strategiesApi,
  type Clause,
  type Guardrails,
  type Operator,
  type SchemaSignal,
} from '@/api/endpoints';
import { Row, Stack, Well } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CodeTabs, SecretValue } from '@/components/ui/Code';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { ApiDirectory, apiGroups } from '@/components/wizard/ApiDirectory';
import { Provisioning } from '@/components/wizard/Provisioning';
import { SchemaAgent } from '@/components/wizard/SchemaAgent';
import { WIZARD_STEPS, WizardShell } from '@/components/wizard/WizardShell';
import { sampleFor } from '@/components/wizard/sampleData';
import { useMutation } from '@/hooks/useAsync';
import type { Directive } from '@/hooks/useSchemaAgent';
import { useSession } from '@/hooks/useSession';
import { DevNexusError } from '@/api/client';
import { money } from '@/lib/format';
import s from './CreateProjectWizard.module.css';

/**
 * The full-screen project creation flow.
 *
 * The project row is created at step 1 and stays `draft` until the last step
 * activates it. That is what makes "Continue later" real: the work already
 * exists server-side, so leaving loses nothing, and a half-finished project is
 * visibly a draft rather than something that looks ready but silently is not.
 *
 * Each step writes its own slice as the user leaves it. Batching everything to
 * the end would mean a dropped connection on step 6 discarded all six.
 */

const OPERATORS: { value: Operator; label: string }[] = [
  { value: '>', label: 'is above' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is below' },
  { value: '<=', label: 'is at most' },
  { value: '==', label: 'equals' },
];

type FieldScope = 'item' | 'global' | 'request';
type FieldType = 'number' | 'string' | 'boolean' | 'enum';

interface SignalRow {
  id: string;
  label: string;
  type: FieldType;
  scope: FieldScope;
  min: string;
  max: string;
}

interface RuleRow {
  name: string;
  field: string;
  operator: Operator;
  value: string;
  percent: string;
  direction: 'increase' | 'decrease';
  /** 'percentage' adjusts by percent/direction; 'formula' computes the price. */
  mode?: 'percentage' | 'formula';
  /** mode === 'formula' only: an expression over the signals and base_price. */
  formulaExpr?: string;
}

interface ItemRow {
  item_id: string;
  name: string;
  base_price: string;
  cost: string;
  /** Values for this product's item-scope signals, keyed by field id. */
  signals: Record<string, string>;
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export default function CreateProjectWizard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { catalog, tenant, refresh, selectProject } = useSession();

  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DevNexusError | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /* ── step 1 ─────────────────────────────────────────────────────────── */
  const [name, setName] = useState('');
  // No longer chosen in the UI: the domain and what's priced are decided with
  // the AI in the schema step, and currency defaults to the tenant's (INR).
  const templateId: string | null = null;
  const domainName = '';
  const entityLabel = 'Item';
  const currency = tenant?.currency ?? 'INR';

  /* ── created project ────────────────────────────────────────────────── */
  const [projectId, setProjectId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');

  /* ── step 2 ─────────────────────────────────────────────────────────── */
  const [signals, setSignals] = useState<SignalRow[]>([]);

  /* ── step 3 ─────────────────────────────────────────────────────────── */
  const [items, setItems] = useState<ItemRow[]>([
    { item_id: '', name: '', base_price: '', cost: '', signals: {} },
  ]);
  // Cost is not a universal field — a SaaS plan or a ticket has no unit cost.
  // Off by default; switched on only when the user says so or the agent adds a
  // cost field because the described domain has one. When off, no cost appears
  // anywhere in Steps 2 or 3.
  const [usesCost, setUsesCost] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /* ── step 4 ─────────────────────────────────────────────────────────── */
  const [prompt, setPrompt] = useState('');
  const [rules, setRules] = useState<RuleRow[]>([]);

  /* ── step 5 ─────────────────────────────────────────────────────────── */
  const [limits, setLimits] = useState({ up: '10', down: '10', margin: '' });

  /* ── step 6 ─────────────────────────────────────────────────────────── */
  const [strategyId, setStrategyId] = useState<string | null>(null);
  /** The build beat has played, so the test run may begin. */
  const [provisioned, setProvisioned] = useState(false);

  const markSaved = () => setSavedAt(Date.now());

  const loadSample = () => {
    const set = sampleFor(templateId, domainName);
    setItems(
      set.items.map((i) => ({
        item_id: i.item_id,
        name: i.name,
        base_price: String(i.base_price),
        cost: i.cost != null ? String(i.cost) : '',
        signals: {},
      })),
    );
    // Only suggest a rule whose signal this project actually declares —
    // otherwise the rule cannot be saved and the suggestion is a dead end.
    const hasField = signals.some((sg) => sg.id === set.suggestedRule.field);
    if (hasField && rules.length === 0) {
      setRules([
        {
          name: set.suggestedRule.name,
          field: set.suggestedRule.field,
          operator: set.suggestedRule.operator,
          value: String(set.suggestedRule.value),
          percent: String(set.suggestedRule.percent),
          direction: 'increase',
        },
      ]);
    }
    toast.success('Sample catalogue loaded', 'Edit anything you like before continuing.');
  };

  /* ── CSV / TSV import ───────────────────────────────────────────────── */
  const importFile = async (file: File) => {
    setUploading(true);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length === 0) throw new Error('That file is empty.');

      const sep = (lines[0]!.match(/\t/g) ?? []).length > (lines[0]!.match(/,/g) ?? []).length ? '\t' : ',';
      const head = lines[0]!.split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const col = (...names: string[]) => head.findIndex((h) => names.includes(h));

      const iId = col('item_id', 'id', 'product_id', 'sku');
      const iName = col('name', 'title', 'product', 'product_name');
      const iPrice = col('base_price', 'price', 'list_price');
      const iCost = col('cost', 'unit_cost');

      if (iId < 0 || iPrice < 0) {
        throw new Error(
          'Could not find an id and a price column. Expected headers like item_id and base_price.',
        );
      }

      const parsed: ItemRow[] = [];
      for (const line of lines.slice(1)) {
        const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
        const id = cells[iId];
        if (!id) continue;
        // Any header that matches an item-scope field becomes that signal's
        // value for this row, so a CSV can carry inventory alongside price.
        const rowSignals: Record<string, string> = {};
        for (const f of itemFields) {
          const ci = col(f.id, f.label.toLowerCase());
          if (ci >= 0 && cells[ci]) rowSignals[f.id] = cells[ci]!;
        }
        parsed.push({
          item_id: id,
          name: (iName >= 0 ? cells[iName] : '') || id,
          base_price: cells[iPrice] ?? '',
          cost: iCost >= 0 ? (cells[iCost] ?? '') : '',
          signals: rowSignals,
        });
      }
      if (parsed.length === 0) throw new Error('No rows with an id were found.');

      // Replace blank starter rows, append to real ones.
      setItems((prev) => {
        const real = prev.filter((r) => r.item_id.trim());
        return [...real, ...parsed];
      });
      toast.success(`${parsed.length} rows imported`, 'Check them over before continuing.');
    } catch (err) {
      toast.error('Could not read that file', err instanceof Error ? err.message : '');
    } finally {
      setUploading(false);
    }
  };

  /* ── step persistence ───────────────────────────────────────────────── */

  const fail = (err: unknown) => {
    const e =
      err instanceof DevNexusError
        ? err
        : new DevNexusError(0, 'unknown', (err as Error)?.message ?? 'Something went wrong.');
    setError(e);
    setBusy(false);
    return false;
  };

  const saveStep = useCallback(async (): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      /* 1 — create the project as a draft */
      if (step === 0) {
        if (!projectId) {
          const p = await projectsApi.create({
            name: name.trim(),
            domain_name: domainName.trim() || name.trim(),
            entity_label: entityLabel.trim() || 'Item',
            currency,
            template_id: templateId ?? undefined,
          });
          setProjectId(p.project_id);
          setApiKey(p.api_key);
          // A template seeds a schema server-side; adopt it if the user has
          // not already edited one, so step 2 opens populated.
          const seeded = (p.schema?.context_signals ?? []) as SchemaSignal[];
          if (signals.length === 0 && seeded.length > 0) {
            setSignals(
              seeded.map((sig) => ({
                id: sig.id,
                label: sig.label ?? sig.id,
                type: (sig.type as FieldType) ?? 'number',
                scope: (sig.scope as FieldScope) ?? 'item',
                min: sig.min != null ? String(sig.min) : '',
                max: sig.max != null ? String(sig.max) : '',
              })),
            );
          }
        }
        markSaved();
      }

      /* 2 — schema */
      if (step === 1 && projectId) {
        await projectsApi.saveDomain(projectId, {
          domain_name: domainName.trim() || name.trim(),
          entity_label: entityLabel.trim() || 'Item',
          attributes: [],
          context_signals: signals
            .filter((sg) => sg.id.trim())
            .map<SchemaSignal>((sg) => ({
              id: sg.id.trim(),
              label: sg.label.trim() || sg.id.trim(),
              type: sg.type,
              scope: sg.scope,
              // Bounds only make sense for a number; sending them on a string
              // field would be a control the engine can't enforce.
              ...(sg.type === 'number' && sg.min !== '' ? { min: Number(sg.min) } : {}),
              ...(sg.type === 'number' && sg.max !== '' ? { max: Number(sg.max) } : {}),
            })),
        });
        markSaved();
      }

      /* 3 — items. Sequential: a 100-item catalogue fired in parallel is a
             burst the API gateway has no reason to absorb. */
      if (step === 2 && projectId) {
        for (const it of items) {
          if (!it.item_id.trim()) continue;
          // Each product carries the current values of its item-scope signals
          // (inventory, capacity…). Non-numeric strings pass through as-is; the
          // backend coerces per the field's declared type.
          const itemSignals: Record<string, number | string> = {};
          for (const f of itemFields) {
            const raw = (it.signals[f.id] ?? '').trim();
            if (raw === '') continue;
            itemSignals[f.id] = f.type === 'number' ? Number(raw) : raw;
          }
          await itemsApi.create({
            project_id: projectId,
            item_id: it.item_id.trim(),
            name: it.name.trim() || it.item_id.trim(),
            base_price: Number(it.base_price),
            cost: usesCost && it.cost !== '' ? Number(it.cost) : undefined,
            signals: Object.keys(itemSignals).length ? itemSignals : undefined,
            // The wizard owns this catalogue, so re-entering a step must not
            // fail on rows it created itself a moment ago.
            overwrite: true,
          });
        }
        markSaved();
      }

      /* 4 — rules & limits, one step: save the LIMITS first (so the live
             config has its boundaries), then create the rules within them,
             then validate + activate the strategy. */
      if (step === 3 && projectId) {
        await projectsApi.saveGuardrails(projectId, {
          max_increase_pct: limits.up !== '' ? Number(limits.up) : null,
          max_decrease_pct: limits.down !== '' ? Number(limits.down) : null,
          min_margin_pct: limits.margin !== '' ? Number(limits.margin) : null,
          min_price: null,
          max_price: null,
        } satisfies Guardrails);

        const ids: string[] = [];
        for (const r of rules) {
          const isFormula = (r.mode ?? 'percentage') === 'formula';
          if (!r.name.trim() || !r.field || r.value === '') continue;
          if (isFormula && !(r.formulaExpr ?? '').trim()) continue;
          const clause: Clause = {
            field: r.field,
            operator: r.operator,
            value: Number(r.value),
          };
          const res = await rulesApi.create({
            project_id: projectId,
            name: r.name.trim(),
            conditions: [clause],
            adjustment: isFormula
              ? {
                  type: 'formula',
                  value: 0,
                  direction: 'increase',
                  expr: (r.formulaExpr ?? '').trim(),
                  formula_mode: 'price',
                }
              : {
                  type: 'percentage',
                  value: Math.abs(Number(r.percent)),
                  direction: r.direction,
                },
            priority: 50,
          });
          ids.push(res.rule_id);
        }
        if (ids.length > 0) {
          const st = await strategiesApi.create({
            project_id: projectId,
            name: `${name.trim() || 'Pricing'} strategy`,
            rule_ids: ids,
          });
          await strategiesApi.validate(projectId, st.strategy_id);
          await strategiesApi.promote(projectId, st.strategy_id, 'active');
          setStrategyId(st.strategy_id);
        }
        markSaved();
      }

      setBusy(false);
      return true;
    } catch (err) {
      return fail(err);
    }
  }, [
    step, projectId, name, domainName, entityLabel, currency, templateId,
    signals, items, rules, limits, strategyId,
  ]);

  const next = async () => {
    const ok = await saveStep();
    if (ok) setStep((v) => Math.min(WIZARD_STEPS.length - 1, v + 1));
  };

  const exit = async () => {
    if (projectId) {
      await refresh();
      toast.info('Saved as a draft', 'Pick it up from the dashboard whenever you like.');
    }
    navigate('/app');
  };

  const finish = async () => {
    if (projectId) {
      await refresh();
      selectProject(projectId);
    }
    // Hand off to the Playground to test the live configuration thoroughly —
    // safely, with no effect on real data.
    navigate('/app/project/playground');
  };

  /* ── validation per step ────────────────────────────────────────────── */
  const canAdvance = useMemo(() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) {
      const ids = signals.filter((sg) => sg.id.trim()).map((sg) => sg.id.trim());
      const unique = new Set(ids).size === ids.length;
      return unique && signals.every((sg) => !sg.id.trim() || sg.label.trim());
    }
    if (step === 2)
      return items.some((i) => i.item_id.trim() && i.base_price !== '' && Number(i.base_price) > 0);
    if (step === 3) return rules.length === 0 || rules.every((r) =>
      r.name.trim() && r.field && r.value !== '' &&
      ((r.mode ?? 'percentage') !== 'formula' ? r.percent !== '' : (r.formulaExpr ?? '').trim() !== ''));
    return true;
  }, [step, name, signals, items, rules]);


  if (!catalog) return <Loading label="Loading" />;

  const firstItem = items[0]?.item_id || 'P1001';
  const firstSignal = signals[0]?.id || 'demand_score';

  // The agent drives the SAME state the manual builder edits, so AI and hand
  // edits stay in one source of truth. Each directive returns a short label for
  // the chat's "applied" chips.
  const handleDirective = useCallback((d: Directive): string | null => {
    const asType = (t: string): FieldType =>
      t === 'string' || t === 'boolean' || t === 'enum' ? (t as FieldType) : 'number';
    const asScope = (sc: string): FieldScope =>
      sc === 'global' || sc === 'request' ? (sc as FieldScope) : 'item';

    // A `cost` field is not a generic signal — it switches on the optional unit
    // cost the engine already understands, rather than adding a column that
    // shadows it. Handle it before the reserved guard.
    if ((d.kind === 'field' && d.id === 'cost')) {
      setUsesCost(true);
      return '+ cost';
    }
    if (d.kind === 'rm' && d.id === 'cost') {
      setUsesCost(false);
      return 'removed cost';
    }

    // The three built-in product fields already exist at item scope — never let
    // a directive add, rename-onto, retype or re-scope one into a duplicate.
    const reservedTarget =
      (d.kind === 'field' && RESERVED_ITEM_IDS.has(d.id)) ||
      (d.kind === 'rm' && RESERVED_ITEM_IDS.has(d.id)) ||
      (d.kind === 'type' && RESERVED_ITEM_IDS.has(d.id)) ||
      (d.kind === 'scope' && RESERVED_ITEM_IDS.has(d.id)) ||
      (d.kind === 'rename' && (RESERVED_ITEM_IDS.has(d.from) || RESERVED_ITEM_IDS.has(d.to)));
    if (reservedTarget) return null;

    if (d.kind === 'field') {
      const row: SignalRow = {
        id: d.id, label: d.label, type: asType(d.type), scope: asScope(d.scope),
        min: d.min ?? '', max: d.max ?? '',
      };
      setSignals((prev) => {
        const i = prev.findIndex((x) => x.id === d.id);
        if (i >= 0) {
          const c = [...prev];
          c[i] = { ...c[i], ...row };
          return c;
        }
        return [...prev, row];
      });
      return `+ ${d.label}`;
    }
    if (d.kind === 'rm') {
      setSignals((p) => p.filter((x) => x.id !== d.id));
      return `removed ${d.id}`;
    }
    if (d.kind === 'rename') {
      setSignals((p) => p.map((x) => (x.id === d.from ? { ...x, id: d.to } : x)));
      return `${d.from} → ${d.to}`;
    }
    if (d.kind === 'type') {
      setSignals((p) => p.map((x) => (x.id === d.id ? { ...x, type: asType(d.value) } : x)));
      return `${d.id}: ${d.value}`;
    }
    if (d.kind === 'scope') {
      setSignals((p) => p.map((x) => (x.id === d.id ? { ...x, scope: asScope(d.value) } : x)));
      return `${d.id} → ${d.value}`;
    }
    if (d.kind === 'product') {
      // Upsert by id: re-emitting the same id UPDATES that row (so "fill the
      // cost" lands on the existing rooms) instead of being dropped or, worse,
      // added again as a duplicate.
      let label: string | null = null;
      setItems((prev) => {
        const real = prev.filter((r) => r.item_id.trim());
        const idx = real.findIndex((r) => r.item_id === d.itemId);
        if (idx >= 0) {
          const row = { ...real[idx]! };
          if (d.name) row.name = d.name;
          if (d.basePrice) row.base_price = d.basePrice;
          if (d.cost) row.cost = d.cost;
          row.signals = { ...row.signals, ...d.signals };
          const copy = [...real];
          copy[idx] = row;
          label = `updated ${d.name || d.itemId}`;
          return copy;
        }
        label = `+ ${d.name}`;
        return [...real, {
          item_id: d.itemId, name: d.name, base_price: d.basePrice,
          cost: d.cost, signals: d.signals,
        }];
      });
      // A sample row that carries a cost means this domain has one — show the
      // column so the value is visible, not silently stored.
      if (d.cost) setUsesCost(true);
      return label;
    }
    if (d.kind === 'rmproduct') {
      // '*' clears every sample row; otherwise remove the one with this id.
      let label: string | null = null;
      setItems((prev) => {
        const real = prev.filter((r) => r.item_id.trim());
        if (d.id === '*') {
          label = `cleared ${real.length}`;
          return [{ item_id: '', name: '', base_price: '', cost: '', signals: {} }];
        }
        if (!real.some((r) => r.item_id === d.id)) return prev;
        label = `removed ${d.id}`;
        return real.filter((r) => r.item_id !== d.id);
      });
      return label;
    }
    return null;
  }, []);

  const schemaSummary = useCallback(
    () => {
      const parts = signals
        .filter((sg) => sg.id.trim())
        .map((sg) => `${sg.id}(${sg.scope},${sg.type})`);
      // cost is a built-in, not a declared signal — but the agent must know it
      // exists so it fills a cost on every sample row (margin floor needs it).
      if (usesCost) parts.push('cost(item,number)');
      return parts.join(', ');
    },
    [signals, usesCost],
  );

  // The current sample rows, so the agent knows exactly what exists when asked
  // to "delete this / delete 20 / delete the rest" or to change rows.
  const itemsSummary = useCallback(
    () =>
      items
        .filter((it) => it.item_id.trim())
        .map((it) => `${it.item_id}(${it.name || '—'})`)
        .join(', '),
    [items],
  );

  // Item-scope fields become editable columns in the products table; they are
  // the only scope stored per product. Global and request fields never appear
  // there — one is project-wide, the other arrives at request time.
  const itemFields = signals.filter((sg) => sg.id.trim() && sg.scope === 'item');
  // Identity columns + one per item-scope field + the delete button. Widths
  // Fixed widths, not fr: a fr column collapses when several item fields are
  // added, which is what merged the columns into each other. Each column keeps
  // a real minimum and the table scrolls horizontally instead.
  const ID_W = 130, NAME_W = 190, PRICE_W = 110, SIG_W = 130, DEL_W = 32;
  // id · name · price · (cost, only when the project uses it) · one per item
  // field · delete. Cost is optional, so its column is dropped entirely when off.
  const priceCols = usesCost ? 2 : 1;
  const productCols = [
    `${ID_W}px`, `${NAME_W}px`, `${PRICE_W}px`,
    ...(usesCost ? [`${PRICE_W}px`] : []),
    ...itemFields.map(() => `${SIG_W}px`),
    `${DEL_W}px`,
  ].join(' ');
  const productMinWidth =
    ID_W + NAME_W + PRICE_W * priceCols + itemFields.length * SIG_W + DEL_W + 7 * 8; // + gaps

  // Rules can test any scope, so every declared field is selectable — with a
  // scope badge, because "inventory < 20" and "traffic < 20" read the same but
  // come from completely different places.
  const SCOPE_LABEL: Record<FieldScope, string> = {
    item: 'item',
    global: 'overall',
    request: 'request',
  };
  const signalOptions = signals
    .filter((sg) => sg.id.trim())
    .map((sg) => ({
      value: sg.id.trim(),
      label: `${sg.label || sg.id} · ${SCOPE_LABEL[sg.scope]}`,
    }));

  /**
   * Turn a sentence into a draft rule in the builder.
   *
   * The response is DATA, not an action: it populates the fields and stops
   * there. Anything the assistant could not map to a signal this project
   * actually has is dropped rather than invented, so a rule that arrives in the
   * builder is always one the engine can evaluate.
   */
  const draftRule = useMutation(
    async () => {
      if (!projectId) throw new Error('The project is still being created.');
      return aiApi.configure(projectId, prompt.trim());
    },
    {
      onSuccess: (res) => {
        const cfg = res.config;
        // The drafter makes ONE rule from ONE clear sentence. If it could not
        // understand the request (vague, or several rules at once like "give me
        // the best rules"), DON'T invent a bogus rule named after the prompt —
        // tell the user why and leave the builder untouched.
        if (!res.understood || !cfg || !cfg.clauses?.length) {
          const why = res.reasons?.[0] || res.clarification ||
            'Try one rule at a time, with a number — e.g. "raise price 10% when stock is below 20". For a whole set of rules, use the assistant inside the project after setup.';
          toast.error("Couldn't turn that into a rule", why);
          return;
        }
        const clause = cfg.clauses[0];
        const known = new Set(signalOptions.map((o) => o.value));
        // A clause naming a signal this project does not have would save as a
        // 400 later, so it is better to leave the field blank and let the user
        // pick than to fill it with something that cannot work.
        const field = clause && known.has(clause.field) ? clause.field : '';
        const adj = cfg?.adjustment;

        // The draft may carry a formula adjustment; the typed shape doesn't name
        // `expr`, so read it defensively.
        const adjX = adj as { type?: string; expr?: string } | undefined;
        const isFormula = adjX?.type === 'formula';
        setRules((prev) => [
          ...prev,
          {
            name: res.suggested_name || prompt.trim().slice(0, 48),
            field: field || signalOptions[0]?.value || '',
            operator: (clause?.operator as RuleRow['operator']) ?? '>',
            value: clause?.value_number != null ? String(clause.value_number) : '',
            percent: adj?.value != null ? String(adj.value) : '5',
            direction: adj?.direction === 'decrease' ? 'decrease' : 'increase',
            mode: isFormula ? 'formula' : 'percentage',
            formulaExpr: isFormula ? (adjX?.expr ?? '') : '',
          },
        ]);
        setPrompt('');
        toast.success(
          'Draft added below',
          field
            ? 'Check it reads the way you meant, then continue.'
            : 'Pick the signal it should watch — the rest is filled in.',
        );
      },
    },
  );

  // The multi-rule counterpart: designs a whole SET of profit-aware rules that
  // respect the guardrails. Each one is a draft the user reviews and edits.
  const bestRules = useMutation(
    async () => {
      if (!projectId) throw new Error('The project is still being created.');
      // Save the limits FIRST so the AI designs rules that fit inside them —
      // this is the whole point of setting limits on the same step as rules.
      await projectsApi.saveGuardrails(projectId, {
        max_increase_pct: limits.up !== '' ? Number(limits.up) : null,
        max_decrease_pct: limits.down !== '' ? Number(limits.down) : null,
        min_margin_pct: limits.margin !== '' ? Number(limits.margin) : null,
        min_price: null,
        max_price: null,
      } satisfies Guardrails);
      return aiApi.bestRules(projectId, prompt.trim() || 'maximize profit within my limits');
    },
    {
      onSuccess: (res) => {
        if (!res.rules.length) {
          toast.error("Couldn't draft rules", 'Add a signal or two first, then try again.');
          return;
        }
        const known = new Set(signalOptions.map((o) => o.value));
        setRules((prev) => [
          ...prev,
          ...res.rules.map<RuleRow>((r) => ({
            name: r.name,
            field: known.has(r.field) ? r.field : (signalOptions[0]?.value ?? ''),
            operator: (r.operator as Operator) ?? '>',
            value: String(r.value),
            percent: r.action === 'formula' ? '5' : String(r.percent ?? 5),
            direction: r.action === 'decrease' ? 'decrease' : 'increase',
            mode: r.action === 'formula' ? 'formula' : 'percentage',
            formulaExpr: r.action === 'formula' ? (r.formula ?? '') : '',
          })),
        ]);
        setPrompt('');
        toast.success(
          `Added ${res.rules.length} rule${res.rules.length === 1 ? '' : 's'}`,
          res.summary || 'Review and edit them below before you continue.',
        );
      },
    },
  );

  return (
    <WizardShell
      steps={WIZARD_STEPS}
      currentIndex={step}
      onBack={() => setStep((v) => Math.max(0, v - 1))}
      onNext={step === WIZARD_STEPS.length - 1 ? finish : next}
      onExit={exit}
      onJump={(i) => setStep(i)}
      nextLabel={
        step === WIZARD_STEPS.length - 1
          ? 'Go to my project'
          : step === 3
            ? 'Build my API'
            : 'Continue'
      }
      nextDisabled={!canAdvance || (step === 4 && !provisioned)}
      busy={busy}
      savedAt={savedAt}
      saving={busy}
      hint={step === 4 && !provisioned ? 'Building your API' : undefined}
    >
      {error && <ErrorState error={error} title="That step could not be saved" />}

      {(step === 1 || step === 2) && (
        <SchemaAgent
          projectId={projectId}
          projectName={name}
          stage={step === 2 ? 'products' : 'schema'}
          schemaSummary={schemaSummary}
          itemsSummary={itemsSummary}
          onDirective={handleDirective}
        />
      )}

      {/* ── 1. project ──────────────────────────────────────────────── */}
      {/* Just a name. Domain and "what you price" are decided with the AI in
          the schema step, and currency defaults to the tenant's (INR) — so the
          first step asks for the one thing only the user can give. */}
      {step === 0 && (
        <Input
          label="Project name"
          autoFocus
          value={name}
          placeholder="Amazon Dynamic Product Pricing"
          onChange={(e) => setName(e.target.value)}
        />
      )}

      {/* ── 2. schema ───────────────────────────────────────────────── */}
      {step === 1 && (
        <div className={s.scopes}>
          <ScopeSection
            scope="item"
            title="About the item"
            blurb={`Information that belongs to each ${entityLabel.toLowerCase()} — its own value that can differ from one to the next.`}
            examples="inventory · capacity · category · location"
            fields={signals}
            setSignals={setSignals}
            usesCost={usesCost}
            onToggleCost={setUsesCost}
          />
          <ScopeSection
            scope="global"
            title="Overall conditions"
            blurb="One value shared across everything you price. You update it once and every item sees it."
            examples="website traffic · market demand · weather · total bookings"
            fields={signals}
            setSignals={setSignals}
          />
          <ScopeSection
            scope="request"
            title="This request"
            blurb="Supplied on each price call and never stored — it is about the customer asking, right now."
            examples="customer tier · quantity · booking channel · membership"
            fields={signals}
            setSignals={setSignals}
          />
        </div>
      )}

      {/* ── 3. products ─────────────────────────────────────────────── */}
      {step === 2 && (
        <>
          <Row>
            <Button size="sm" variant="secondary" icon="sparkle" onClick={loadSample}>
              Load sample {entityLabel.toLowerCase()}s
            </Button>
            <Button size="sm" variant="ghost" icon="upload" loading={uploading}
              onClick={() => fileRef.current?.click()}>
              Import CSV
            </Button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }} />
          </Row>

          <div className={s.priceLegend}>
            <span><strong>Price</strong> — what the customer pays</span>
            {usesCost && <span><strong>Cost</strong> — what it costs your business</span>}
          </div>

          <div className={s.productScroll}>
            <div
              className={s.tableHead}
              style={{ gridTemplateColumns: productCols, minWidth: productMinWidth }}
            >
              <span>{entityLabel} ID</span>
              <span>Name</span>
              <span>Price</span>
              {usesCost && <span>Cost</span>}
              {itemFields.map((f) => (
                <span key={f.id} title={f.label}>{f.label}</span>
              ))}
              <span />
            </div>
            {items.map((it, i) => (
              <div key={i} className={s.tableRow} style={{ gridTemplateColumns: productCols, minWidth: productMinWidth }}>
                <Input aria-label="Item id" mono value={it.item_id} placeholder="P1001"
                  onChange={(e) => setItems((p) => p.map((x, j) => j === i ? { ...x, item_id: e.target.value } : x))} />
                <Input aria-label="Name" value={it.name} placeholder="Ball Pen"
                  onChange={(e) => setItems((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <Input aria-label="Price" type="number" prefix={currency} value={it.base_price}
                  onChange={(e) => setItems((p) => p.map((x, j) => j === i ? { ...x, base_price: e.target.value } : x))} />
                {usesCost && (
                  <Input aria-label="Cost" type="number" prefix={currency} value={it.cost}
                    onChange={(e) => setItems((p) => p.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} />
                )}
                {itemFields.map((f) => (
                  <Input
                    key={f.id}
                    aria-label={f.label}
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={it.signals[f.id] ?? ''}
                    placeholder={f.type === 'number' ? '0' : ''}
                    onChange={(e) => setItems((p) => p.map((x, j) =>
                      j === i ? { ...x, signals: { ...x.signals, [f.id]: e.target.value } } : x))}
                  />
                ))}
                <button type="button" className={s.rowDelete} aria-label="Remove row"
                  disabled={items.length === 1}
                  onClick={() => setItems((p) => p.filter((_, j) => j !== i))}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>

          <Row>
            <Button size="sm" variant="ghost" icon="plus"
              onClick={() => setItems((p) => [...p, { item_id: '', name: '', base_price: '', cost: '', signals: {} }])}>
              Add a row
            </Button>
            <span className={s.note}>
              {items.filter((i) => i.item_id.trim()).length} ready · only item-scope fields
              appear here — overall and request values are set at runtime
            </span>
          </Row>
        </>
      )}

      {/* ── 4. rules & limits (one step, limits first) ──────────────────
          Limits are set BEFORE the rules so the AI designs rules that fit
          inside them, instead of ones the guardrails have to fight. */}
      {step === 3 && (
        <>
          {/* ── Limits: the boundaries ── */}
          <section className={s.scope}>
            <div className={s.scopeHead}>
              <span className={s.scopeIcon}><Icon name="shield" size={15} /></span>
              <div>
                <div className={s.scopeTitle}>Limits — the boundaries</div>
                <div className={s.scopeBlurb}>
                  Set these first. However much the rules ask for, the price is held inside this band.
                </div>
              </div>
            </div>
            <div className={s.limitsBody}>
              <Row>
                <Input label="Maximum increase" type="number" suffix="%" value={limits.up}
                  hint="The most a price may rise in one decision."
                  onChange={(e) => setLimits((l) => ({ ...l, up: e.target.value }))} />
                <Input label="Maximum decrease" type="number" suffix="%" value={limits.down}
                  hint="The most it may fall in one decision."
                  onChange={(e) => setLimits((l) => ({ ...l, down: e.target.value }))} />
                <Input label="Minimum margin" type="number" suffix="%" optional value={limits.margin}
                  hint="Needs a cost on each item."
                  onChange={(e) => setLimits((l) => ({ ...l, margin: e.target.value }))} />
              </Row>
              {items[0]?.base_price && limits.up && (
                <p className={s.note} style={{ marginTop: 'var(--s-3)' }}>
                  A {money(Number(items[0].base_price), currency)} {entityLabel.toLowerCase()} can never go above{' '}
                  <strong>{money(Number(items[0].base_price) * (1 + Number(limits.up) / 100), currency)}</strong>
                  {limits.down && (
                    <> or below{' '}
                      <strong>{money(Number(items[0].base_price) * (1 - Number(limits.down) / 100), currency)}</strong>
                    </>
                  )}{' '}in one decision — whatever the rules ask.
                </p>
              )}
            </div>
          </section>

          {/* ── Rules: how the price moves, within those limits ── */}
          <div className={s.rulesLabel}>
            <Icon name="rules" size={15} />
            <span>Rules — how the price moves, inside your limits</span>
          </div>

          {/* Describing the rule is how most people think about pricing — the
              builder below is how the engine needs it written. The assistant
              translates between the two and nothing more: it fills the fields,
              and the user still reviews and edits before anything is saved.
              It cannot save a rule, and it never prices anything. */}
          <div className={s.describe}>
            <div className={s.describeHead}>
              <Icon name="sparkle" size={15} />
              <span>Describe it in your own words</span>
              <span className={s.describeTag}>optional</span>
            </div>
            <Textarea
              aria-label="Describe the rule"
              rows={2}
              value={prompt}
              placeholder={`e.g. when ${signalOptions[0]?.label?.toLowerCase() ?? 'demand'} goes above 80, raise the price by 10%`}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <Row>
              <Button
                size="sm"
                variant="secondary"
                icon="sparkle"
                loading={draftRule.pending}
                disabled={!prompt.trim() || signalOptions.length === 0}
                onClick={() => void draftRule.run()}
              >
                Draft this rule
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="sparkle"
                loading={bestRules.pending}
                disabled={signalOptions.length === 0}
                onClick={() => void bestRules.run()}
              >
                Write the best rules
              </Button>
            </Row>
            <span className={s.note}>
              <strong>Draft this rule</strong> turns one sentence into one rule.{' '}
              <strong>Write the best rules</strong> designs a whole set to maximise profit
              within your limits — review and edit them below. Nothing saves until you continue.
            </span>
            {draftRule.error && (
              <span className={s.describeError}>
                {draftRule.error.message} You can still write the rule by hand below.
              </span>
            )}
          </div>

          {rules.length === 0 && (
            <Well>
              <p className={s.note}>
                No rules yet. Without one, every {entityLabel.toLowerCase()} simply stays at its
                base price — which is a perfectly valid place to start.
              </p>
            </Well>
          )}

          {rules.map((r, i) => {
            const mode = r.mode ?? 'percentage';
            return (
            <div key={i} className={s.ruleCard}>
              <div className={s.ruleCardHead}>
                <div className={s.ruleNameField}>
                  <div className={s.fieldLabel}>Rule name</div>
                  <Input aria-label="Rule name" value={r.name} placeholder="e.g. High demand premium"
                    onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                </div>
                <Button size="sm" variant="ghost" icon="close"
                  onClick={() => setRules((p) => p.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
              <div className={s.ruleLine}>
                <span className={s.kw}>WHEN</span>
                <Select aria-label="Signal" value={r.field} placeholder="choose a signal"
                  options={signalOptions}
                  onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} />
                <Select aria-label="Operator" value={r.operator} options={OPERATORS}
                  onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, operator: e.target.value as Operator } : x))} />
                <Input aria-label="Value" type="number" value={r.value} placeholder="80"
                  onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              </div>
              <div className={mode === 'formula' ? `${s.ruleLine} ${s.ruleLineFormula}` : s.ruleLine}>
                <span className={s.kw}>THEN</span>
                <Select aria-label="Action" value={mode === 'formula' ? 'formula' : r.direction}
                  options={[
                    { value: 'increase', label: 'increase price by' },
                    { value: 'decrease', label: 'decrease price by' },
                    { value: 'formula', label: 'compute with a formula' },
                  ]}
                  onChange={(e) => setRules((p) => p.map((x, j) => {
                    if (j !== i) return x;
                    return e.target.value === 'formula'
                      ? { ...x, mode: 'formula' }
                      : { ...x, mode: 'percentage', direction: e.target.value as 'increase' | 'decrease' };
                  }))} />
                {mode === 'formula' ? (
                  <Input aria-label="Formula" mono placeholder="base_price * (1 + occupancy / 200)"
                    value={r.formulaExpr ?? ''}
                    onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, formulaExpr: e.target.value } : x))} />
                ) : (
                  <Input aria-label="Percent" type="number" suffix="%" value={r.percent} placeholder="5"
                    onChange={(e) => setRules((p) => p.map((x, j) => j === i ? { ...x, percent: e.target.value } : x))} />
                )}
              </div>
              {mode === 'formula' && (
                <div className={s.note}>
                  Write the new price as an equation. Use your field ids, <code>base_price</code> and{' '}
                  <code>cost</code> — e.g. <code>base_price * (1 + occupancy / 200)</code>.
                </div>
              )}
              {mode !== 'formula' && r.field && r.value !== '' && r.percent !== '' && (
                <div className={s.sentence}>
                  When <strong>{r.field}</strong>{' '}
                  {OPERATORS.find((o) => o.value === r.operator)?.label} <strong>{r.value}</strong>,{' '}
                  {r.direction} the price by <strong>{r.percent}%</strong>.
                </div>
              )}
            </div>
            );
          })}

          <Row>
            <Button size="sm" variant="ghost" icon="plus"
              disabled={signalOptions.length === 0}
              onClick={() => setRules((p) => [...p, {
                name: '', field: signalOptions[0]?.value ?? '', operator: '>',
                value: '', percent: '5', direction: 'increase',
                mode: 'percentage', formulaExpr: '',
              }])}>
              Add a rule
            </Button>
            {signalOptions.length === 0 && (
              <span className={s.note}>Add a signal in the previous step first.</span>
            )}
          </Row>
        </>
      )}

      {/* ── 5. build + live ─────────────────────────────────────────────
          The API is provisioned and shown as a thing that now exists. Testing
          is NOT done here — it lives in the Playground, so it happens once, in
          one place, rather than twice. */}
      {step === 4 && projectId && !provisioned && (
        <Provisioning onDone={() => setProvisioned(true)} />
      )}

      {step === 4 && provisioned && (
        <Stack>
          <Well>
            <div className={s.fieldLabel}>Your API key</div>
            <SecretValue value={apiKey} />
            <p className={s.note} style={{ marginTop: 'var(--s-3)' }}>
              Keep this on your server. Anyone holding it can request prices for this project.
            </p>
          </Well>

          <div>
            <div className={s.apiHead}>
              <Badge tone="accent" caps>1</Badge>
              <strong>Get a price</strong>
              <span className={s.note}>the call your checkout makes</span>
            </div>
            <CodeTabs tabs={priceTabs(apiKey, items[0]?.item_id || 'P1001')} />
          </div>

          <div>
            <div className={s.apiHead}>
              <Badge tone="accent" caps>2</Badge>
              <strong>Send context</strong>
              <span className={s.note}>what moves the price</span>
            </div>
            <CodeTabs tabs={eventTabs(apiKey, items[0]?.item_id || 'P1001', signals[0]?.id || 'demand_score')} />
          </div>

          <div>
            <div className={s.apiHead}>
              <Badge tone="neutral" caps>all</Badge>
              <strong>Everything else you can call</strong>
              <span className={s.note}>grouped by what it is for</span>
            </div>
            <ApiDirectory base={API_BASE} groups={apiGroups(apiKey, firstItem, firstSignal)} />
          </div>
        </Stack>
      )}
    </WizardShell>
  );
}


/* ── schema: one scope's fields ───────────────────────────────────────── */

const TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'string', label: 'Text' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'enum', label: 'Category' },
];

const SCOPE_ICON: Record<FieldScope, IconName> = {
  item: 'projects',
  global: 'analytics',
  request: 'decisions',
};

/**
 * The item-scope fields every product has before you add anything. They are
 * part of the product itself, not signals you declare — so they show here,
 * locked, to make clear they already exist and the id/name/base_price/cost
 * you fill in on the next step are these very fields.
 */
const ITEM_BUILTINS: { id: string; label: string; note: string }[] = [
  { id: 'item_id', label: 'Product id', note: 'What every price and decision is filed under' },
  { id: 'name', label: 'Product name', note: 'Shown in the dashboard and explanations' },
  { id: 'base_price', label: 'Price', note: 'The value being set — what every rule adjusts' },
];

/**
 * The ids a declared signal can never use. The three above are the only fields
 * every project is guaranteed to have at item scope; `price`/`cost` name the
 * same engine concepts. A directive (or a paste) trying to redeclare, rename or
 * retype one is ignored rather than creating a duplicate that shadows the real
 * field. `cost` is deliberately NOT here — it is an optional field the user or
 * agent can switch on when the domain actually has a unit cost.
 */
const RESERVED_ITEM_IDS = new Set([...ITEM_BUILTINS.map((b) => b.id), 'price']);

/**
 * One scope's fields, as an add/edit/delete table.
 *
 * All three scopes share this component — the only thing that differs is which
 * `scope` a new field is stamped with. Min and max appear only for a number,
 * because the backend can only enforce bounds on a number; showing them on a
 * text field would be a control that does nothing.
 */
function ScopeSection({
  scope,
  title,
  blurb,
  examples,
  fields,
  setSignals,
  usesCost = false,
  onToggleCost,
}: {
  scope: FieldScope;
  title: string;
  blurb: string;
  examples: string;
  fields: SignalRow[];
  setSignals: Dispatch<SetStateAction<SignalRow[]>>;
  /** Item scope only: whether the optional unit-cost field is on. */
  usesCost?: boolean;
  onToggleCost?: (on: boolean) => void;
}) {
  // The built-in product fields, shown for the item scope. Cost is optional and
  // only joins the list when the user (or the AI) turns it on.
  const builtins = scope === 'item'
    ? [
        ...ITEM_BUILTINS,
        ...(usesCost
          ? [{ id: 'cost', label: 'Unit cost', note: 'What it costs you — lets rules protect your margin', removable: true }]
          : []),
      ]
    : [];
  // Indices into the shared signals array, so edits map back to the right row.
  const rows = fields
    .map((f, i) => ({ f, i }))
    .filter((r) => r.f.scope === scope);

  const patch = (idx: number, change: Partial<SignalRow>) =>
    setSignals((p) => p.map((x, j) => (j === idx ? { ...x, ...change } : x)));

  const add = () =>
    setSignals((p) => [
      ...p,
      { id: '', label: '', type: 'number', scope, min: '', max: '' },
    ]);

  return (
    <section className={s.scope}>
      <div className={s.scopeHead}>
        <span className={s.scopeIcon}>
          <Icon name={SCOPE_ICON[scope]} size={15} />
        </span>
        <div>
          <div className={s.scopeTitle}>{title}</div>
          <div className={s.scopeBlurb}>{blurb}</div>
        </div>
      </div>

      {scope === 'item' && (
        <div className={s.builtins}>
          <div className={s.builtinsCaption}>Always included</div>
          {builtins.map((b) => (
            <div key={b.id} className={s.builtinRow}>
              <code className={s.lockedId}>{b.id}</code>
              <span className={s.lockedNote}>{b.note}</span>
              {'removable' in b && b.removable ? (
                <button
                  type="button"
                  className={s.builtinRemove}
                  title="Remove unit cost"
                  onClick={() => onToggleCost?.(false)}
                >
                  <Icon name="close" size={13} />
                </button>
              ) : (
                <span className={s.lockedIcon} title="Built-in — always present">
                  <Icon name="shield" size={13} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className={s.scopeTable}>
          <div className={s.scopeRow} data-head="true">
            <span>Field id</span>
            <span>What it means</span>
            <span>Type</span>
            <span>Min</span>
            <span>Max</span>
            <span />
          </div>
          {rows.map(({ f, i }) => (
            <div key={i} className={s.scopeRow}>
              <Input aria-label="Field id" mono value={f.id} placeholder="inventory"
                onChange={(e) => patch(i, { id: slug(e.target.value) })} />
              <Input aria-label="Description" value={f.label} placeholder="Units in stock"
                onChange={(e) => patch(i, { label: e.target.value })} />
              <Select aria-label="Type" value={f.type} options={TYPE_OPTIONS}
                onChange={(e) => patch(i, { type: e.target.value as FieldType })} />
              {f.type === 'number' ? (
                <>
                  <Input aria-label="Minimum" type="number" value={f.min} placeholder="0"
                    onChange={(e) => patch(i, { min: e.target.value })} />
                  <Input aria-label="Maximum" type="number" value={f.max} placeholder="100"
                    onChange={(e) => patch(i, { max: e.target.value })} />
                </>
              ) : (
                <>
                  <span className={s.scopeDash}>—</span>
                  <span className={s.scopeDash}>—</span>
                </>
              )}
              <button type="button" className={s.rowDelete} aria-label="Remove field"
                onClick={() => setSignals((p) => p.filter((_, j) => j !== i))}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={s.scopeFoot}>
        <Button size="sm" variant="ghost" icon="plus" onClick={add}>
          Add {scope === 'item' ? 'an item' : scope === 'global' ? 'an overall' : 'a request'} field
        </Button>
        {scope === 'item' && !usesCost && onToggleCost && (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => onToggleCost(true)}>
            Add unit cost
          </Button>
        )}
        {rows.length === 0 && <span className={s.scopeExamples}>e.g. {examples}</span>}
      </div>
    </section>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function slug(v: string) {
  return v.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+/, '');
}

function priceTabs(key: string, item: string) {
  const url = `${API_BASE}/v1/p/${key}/price`;
  return [
    { id: 'curl', label: 'cURL', code: `curl -s "${url}?item_id=${item}"` },
    {
      id: 'js', label: 'JavaScript',
      code: `const res = await fetch(
  \`${API_BASE}/v1/p/\${process.env.DEVNEXUS_KEY}/price?item_id=\${id}\`,
  { cache: 'no-store' },
);
const { price } = await res.json();

// Keep price.decision_id with the order — it is how you explain
// this exact price to a customer later.
return price.price;`,
    },
    {
      id: 'python', label: 'Python',
      code: `import os, requests

KEY = os.environ["DEVNEXUS_KEY"]

def get_price(item_id: str) -> float:
    r = requests.get(
        f"${API_BASE}/v1/p/{KEY}/price",
        params={"item_id": item_id}, timeout=5,
    )
    return r.json()["price"]["price"]`,
    },
  ];
}

function eventTabs(key: string, item: string, signal: string) {
  const url = `${API_BASE}/v1/t/${key}/event`;
  return [
    {
      id: 'curl', label: 'cURL',
      code: `curl -s "${url}?item_id=${item}&event_type=signal_update\\
&event_id=evt_$(date +%s)&signal_${signal}=92"`,
    },
    {
      id: 'js', label: 'JavaScript',
      code: `// event_id makes this idempotent — a retry will not double-count.
const params = new URLSearchParams({
  item_id: '${item}',
  event_type: 'signal_update',
  event_id: crypto.randomUUID(),
  signal_${signal}: '92',
});
await fetch(\`${API_BASE}/v1/t/\${KEY}/event?\${params}\`);`,
    },
    {
      id: 'python', label: 'Python',
      code: `import uuid, requests

requests.get(
    f"${API_BASE}/v1/t/{KEY}/event",
    params={
        "item_id": "${item}",
        "event_type": "signal_update",
        "event_id": str(uuid.uuid4()),
        "signal_${signal}": 92,
    }, timeout=3,
)`,
    },
  ];
}
