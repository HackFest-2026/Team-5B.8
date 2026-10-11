import type { Clause } from '@/api/endpoints';

/**
 * Builds the test plan from the project the user just configured.
 *
 * Every case is derived from THEIR numbers — their base price, their cost,
 * their rule thresholds, their guardrail percentages. A fixed set of demo tests
 * would pass regardless of what they typed, which proves nothing; these fail if
 * their configuration is genuinely wrong.
 *
 * The expected value is computed here with the same arithmetic the engine uses
 * (percentages SUM rather than compound, guardrails apply last). That is a
 * deliberate second implementation: if this disagrees with the server, the test
 * fails and the disagreement is the finding.
 */

export interface DraftRule {
  name: string;
  clauses: Clause[];
  /** Percentage points. Positive raises, negative lowers. */
  percent: number;
}

export interface DraftItem {
  item_id: string;
  name: string;
  base_price: number;
  cost?: number | null;
}

export interface DraftLimits {
  maxIncreasePct?: number | null;
  maxDecreasePct?: number | null;
  minMarginPct?: number | null;
}

export interface TestCase {
  id: string;
  title: string;
  /** Why this case is worth running, in the user's own terms. */
  rationale: string;
  itemId: string;
  itemName: string;
  /** Signal overrides sent to /simulate/whatif. */
  signals: Record<string, number>;
  expected: number;
  /** What the user should understand from the expected number. */
  expectation: string;
}

/** A number the clause is satisfied by, and one it is not. */
function satisfying(clause: Clause): number | null {
  const v = typeof clause.value === 'number' ? clause.value : Number(clause.value);
  if (Number.isNaN(v)) return null;
  switch (clause.operator) {
    case '>':
    case '>=':
      // Comfortably past the line, so a boundary quirk cannot make the test
      // ambiguous about whether the rule should have fired.
      return v + Math.max(1, Math.abs(v) * 0.15);
    case '<':
    case '<=':
      return Math.max(0, v - Math.max(1, Math.abs(v) * 0.15));
    case '==':
      return v;
    case 'between':
      return clause.value2 !== undefined ? (v + clause.value2) / 2 : v;
    default:
      return null;
  }
}

function violating(clause: Clause): number | null {
  const v = typeof clause.value === 'number' ? clause.value : Number(clause.value);
  if (Number.isNaN(v)) return null;
  switch (clause.operator) {
    case '>':
    case '>=':
      return Math.max(0, v - Math.max(1, Math.abs(v) * 0.3));
    case '<':
    case '<=':
      return v + Math.max(1, Math.abs(v) * 0.3);
    case '==':
      return v + 1;
    case 'between':
      return v - Math.max(1, Math.abs(v) * 0.3);
    default:
      return null;
  }
}

function signalsFor(rule: DraftRule, mode: 'satisfy' | 'violate'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of rule.clauses) {
    const v = mode === 'satisfy' ? satisfying(c) : violating(c);
    if (v !== null) out[c.field] = Math.round(v * 100) / 100;
  }
  return out;
}

/** Round the way the engine does — once, at the end, to 2dp. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Apply percentage adjustments the way the engine does.
 *
 * Percentages SUM against the base rather than compounding, so two +5% rules
 * give +10%, not +10.25%. Guardrails are then applied to the result.
 */
function priceWith(base: number, percentTotal: number, limits: DraftLimits, cost?: number | null) {
  let price = base * (1 + percentTotal / 100);

  const up = limits.maxIncreasePct;
  if (up !== null && up !== undefined && price > base * (1 + up / 100)) {
    price = base * (1 + up / 100);
  }
  const down = limits.maxDecreasePct;
  if (down !== null && down !== undefined && price < base * (1 - down / 100)) {
    price = base * (1 - down / 100);
  }
  const margin = limits.minMarginPct;
  if (margin !== null && margin !== undefined && cost) {
    const floor = cost / (1 - margin / 100);
    if (price < floor) price = floor;
  }
  return money(price);
}

/**
 * How many cases the plan aims for, and how many it will never exceed.
 *
 * The floor exists because a handful of checks does not feel like testing; the
 * ceiling because every case is a real round trip to the pricing API, and
 * forty of them is a wait, not a demonstration.
 */
const MIN_CASES = 10;
const MAX_CASES = 16;

/** Which signal values make this rule fire, or definitely not fire. */
function boundaryFor(clause: Clause, side: 'under' | 'at'): number | null {
  const v = typeof clause.value === 'number' ? clause.value : Number(clause.value);
  if (Number.isNaN(v)) return null;
  const step = Math.max(1, Math.abs(v) * 0.02);
  switch (clause.operator) {
    case '>':
      return side === 'at' ? v : v - step;
    case '>=':
      return side === 'at' ? v : v - step;
    case '<':
      return side === 'at' ? v : v + step;
    case '<=':
      return side === 'at' ? v : v + step;
    default:
      return null;
  }
}

/** Does this rule fire exactly ON its threshold? `>` and `<` do not. */
function firesAtThreshold(clause: Clause): boolean {
  return clause.operator === '>=' || clause.operator === '<=' || clause.operator === '==';
}

/**
 * Every case worth running for one product.
 *
 * Split out per item so the plan scales with the catalogue: ten products means
 * ten real price checks, each against that product's own base price, rather
 * than ten variations on the first one.
 */
function casesForItem(
  item: DraftItem,
  rules: readonly DraftRule[],
  limits: DraftLimits,
  opts: { deep: boolean },
): TestCase[] {
  const out: TestCase[] = [];
  const base = item.base_price;
  const tag = item.item_id;

  // 1. The quiet case. Nothing should happen, and a setup that moves the price
  //    when no rule matches is broken in the most expensive way. It also proves
  //    this product reached the catalogue with the price that was typed.
  const calm: Record<string, number> = {};
  for (const r of rules) Object.assign(calm, signalsFor(r, 'violate'));
  out.push({
    id: `baseline-${tag}`,
    title: `${item.name} holds at its base price`,
    rationale: 'No rule should fire when nothing unusual is happening.',
    itemId: item.item_id,
    itemName: item.name,
    signals: calm,
    expected: money(base),
    expectation: `stays at the base price of ${base}`,
  });

  if (!opts.deep) return out;

  // 2. One case per rule, in isolation — so a failure names the rule.
  for (const [i, rule] of rules.entries()) {
    const expected = priceWith(base, rule.percent, limits, item.cost);
    const direction = rule.percent >= 0 ? 'raises' : 'lowers';
    out.push({
      id: `rule-${i}-${tag}`,
      title: `“${rule.name}” fires on ${item.name}`,
      rationale: 'Checks this rule on its own, so a failure points at one rule rather than a combination.',
      itemId: item.item_id,
      itemName: item.name,
      signals: signalsFor(rule, 'satisfy'),
      expected,
      expectation: `${direction} the price to ${expected}`,
    });
  }

  // 3. The threshold itself. Off-by-one at the boundary is the single most
  //    common pricing bug, and it is invisible until a customer hits it.
  for (const [i, rule] of rules.entries()) {
    const clause = rule.clauses[0];
    if (!clause) continue;

    const under = boundaryFor(clause, 'under');
    if (under !== null) {
      out.push({
        id: `under-${i}-${tag}`,
        title: `Just short of “${rule.name}” changes nothing`,
        rationale: `At ${under} the condition is not met, so the price must not move.`,
        itemId: item.item_id,
        itemName: item.name,
        signals: { ...calm, [clause.field]: under },
        expected: money(base),
        expectation: `stays at ${money(base)}`,
      });
    }

    const at = boundaryFor(clause, 'at');
    if (at !== null) {
      const fires = firesAtThreshold(clause);
      const expected = fires ? priceWith(base, rule.percent, limits, item.cost) : money(base);
      out.push({
        id: `at-${i}-${tag}`,
        title: `Exactly on the “${rule.name}” threshold`,
        rationale: fires
          ? `“${clause.operator}” includes the boundary, so ${at} must fire.`
          : `“${clause.operator}” excludes the boundary, so ${at} must NOT fire.`,
        itemId: item.item_id,
        itemName: item.name,
        signals: { ...calm, [clause.field]: at },
        expected,
        expectation: fires ? `fires and lands on ${expected}` : `holds at ${expected}`,
      });
    }
  }

  // 4. Everything at once. This is where stacking and the guardrail cap show up,
  //    and it is the case people are most often surprised by.
  if (rules.length > 1) {
    const all: Record<string, number> = {};
    for (const r of rules) Object.assign(all, signalsFor(r, 'satisfy'));
    const total = rules.reduce((sum, r) => sum + r.percent, 0);
    const expected = priceWith(base, total, limits, item.cost);
    const uncapped = money(base * (1 + total / 100));
    out.push({
      id: `combined-${tag}`,
      title: `Every rule fires together on ${item.name}`,
      rationale:
        expected !== uncapped
          ? `Rules would combine to ${uncapped}; your limit holds it at ${expected}.`
          : `Rules combine to ${total > 0 ? '+' : ''}${total}% — they add up rather than multiplying.`,
      itemId: item.item_id,
      itemName: item.name,
      signals: all,
      expected,
      expectation: `lands on ${expected}`,
    });
  }

  // 5. The cap, proved directly. Only worth asserting when the rules could
  //    actually exceed it — otherwise it tests nothing.
  const totalUp = rules.reduce((sum, r) => sum + Math.max(0, r.percent), 0);
  const cap = limits.maxIncreasePct;
  if (cap !== null && cap !== undefined && totalUp > cap) {
    const all: Record<string, number> = {};
    for (const r of rules.filter((r) => r.percent > 0)) Object.assign(all, signalsFor(r, 'satisfy'));
    const expected = money(base * (1 + cap / 100));
    out.push({
      id: `cap-${tag}`,
      title: `The ${cap}% limit holds on ${item.name}`,
      rationale: `Your rules ask for +${totalUp}% together. The limit must stop it at +${cap}%.`,
      itemId: item.item_id,
      itemName: item.name,
      signals: all,
      expected,
      expectation: `is capped at ${expected}, not ${money(base * (1 + totalUp / 100))}`,
    });
  }

  // 6. Margin protection, only when a cost is actually known.
  if (item.cost && limits.minMarginPct) {
    const all: Record<string, number> = {};
    for (const r of rules.filter((r) => r.percent < 0)) Object.assign(all, signalsFor(r, 'satisfy'));
    const total = rules.filter((r) => r.percent < 0).reduce((s, r) => s + r.percent, 0);
    if (total < 0) {
      const expected = priceWith(base, total, limits, item.cost);
      out.push({
        id: `margin-${tag}`,
        title: `${item.name} is never sold below your margin`,
        rationale: `Cost is ${item.cost}, and you require ${limits.minMarginPct}% margin.`,
        itemId: item.item_id,
        itemName: item.name,
        signals: all,
        expected,
        expectation: `holds at ${expected} to protect the margin`,
      });
    }
  }

  return out;
}

/**
 * The plan.
 *
 * Breadth comes from the catalogue and depth from the rules: the first few
 * products get the full treatment (isolation, boundaries, stacking, limits)
 * and every remaining product gets its own base-price check, which is a real
 * assertion that the product was stored with the price that was typed.
 *
 * The result is a plan that grows with what the user actually built rather
 * than a fixed list that would pass no matter what they configured.
 */
export function buildTests(
  items: readonly DraftItem[],
  rules: readonly DraftRule[],
  limits: DraftLimits,
): TestCase[] {
  if (items.length === 0) return [];

  // Cheapest and dearest first: guardrails and margin floors bite at the ends
  // of the price range, never in the middle.
  const ordered = [...items].sort((a, b) => a.base_price - b.base_price);
  const spread: DraftItem[] = [];
  let lo = 0;
  let hi = ordered.length - 1;
  while (lo <= hi) {
    spread.push(ordered[lo]!);
    if (lo !== hi) spread.push(ordered[hi]!);
    lo += 1;
    hi -= 1;
  }

  const cases: TestCase[] = [];

  // Depth on the first few, so the rule logic is exercised from both ends of
  // the price range without running the full battery on a hundred products.
  const deepCount = Math.min(spread.length, rules.length > 0 ? 2 : 1);
  for (let i = 0; i < deepCount; i += 1) {
    cases.push(...casesForItem(spread[i]!, rules, limits, { deep: true }));
  }

  // Then breadth, until the plan is a real plan or the catalogue runs out.
  for (let i = deepCount; i < spread.length && cases.length < MAX_CASES; i += 1) {
    cases.push(...casesForItem(spread[i]!, rules, limits, { deep: false }));
  }

  // Still thin — a small catalogue with few rules. Go deeper on what there is
  // rather than inventing cases that assert nothing.
  for (let i = deepCount; i < spread.length && cases.length < MIN_CASES; i += 1) {
    const extra = casesForItem(spread[i]!, rules, limits, { deep: true });
    for (const c of extra) {
      if (cases.length >= MAX_CASES) break;
      if (!cases.some((existing) => existing.id === c.id)) cases.push(c);
    }
  }

  return cases.slice(0, MAX_CASES);
}
