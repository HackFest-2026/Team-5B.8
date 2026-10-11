/**
 * Every DevNexus endpoint the web app uses, as a typed function.
 *
 * The rules this file follows:
 *
 *  - One function per backend route, named after the product action rather than
 *    the HTTP path, so call sites read as intent.
 *  - Parameter names match the backend's query parameters exactly. When they
 *    differ, a bug becomes invisible: the server just ignores the unknown
 *    parameter and falls back to its default.
 *  - Optional parameters are `undefined`-able, never defaulted here. The
 *    server owns the defaults; duplicating them would mean two sources of
 *    truth that drift apart.
 *  - Structured values go through `json()`, lists through `csv()`.
 *
 * Nothing in this file invents an endpoint. Each one was verified against
 * backend/app/routers/*.py.
 */

import { auth, csv, json, pub, type Params, type RequestOptions } from './client';
import type {
  AiConfigureResponse,
  AiTestcasesResponse,
  AiBestRulesResponse,
  AiChatHistoryResponse,
  AiHealthResponse,
  AlertListResponse,
  ApprovalHistoryResponse,
  AuditListResponse,
  BacktestListResponse,
  BacktestResultResponse,
  BulkPriceResponse,
  CatalogResponse,
  CompareResponse,
  ConnectionsResponse,
  CreateItemResponse,
  CreateProjectResponse,
  CreateRuleResponse,
  CreateStrategyResponse,
  DataJobListResponse,
  DataJobResponse,
  DecisionListResponse,
  DecisionReplayResponse,
  DecisionVerifyResponse,
  DemoTrafficResponse,
  DomainsResponse,
  ForecastResponse,
  HealthResponse,
  ItemDetailResponse,
  ItemListResponse,
  LiveDecisionsResponse,
  LiveEventsResponse,
  LoginResponse,
  MeResponse,
  OverviewResponse,
  PendingApprovalsResponse,
  PipelineResponse,
  PriceResponse,
  ProjectDetailResponse,
  ProjectListResponse,
  PromoteStrategyResponse,
  PulseResponse,
  RuleAnalyticsResponse,
  RuleConflictsResponse,
  RuleListResponse,
  SaveDomainResponse,
  SaveGuardrailsResponse,
  ShadowComparisonResponse,
  SignupResponse,
  StrategyDetailResponse,
  StrategyListResponse,
  SystemHealthResponse,
  TimeseriesResponse,
  UpdateRuleResponse,
  UploadUrlResponse,
  ValidateStrategyResponse,
  WhatIfResponse,
} from './types';

/* ===========================================================================
   Domain vocabulary
   ---------------------------------------------------------------------------
   The server validates these; mirroring them as unions means a typo is a
   compile error rather than a 400 at runtime. Sourced from core/catalog.py
   and the router validators.
   =========================================================================== */

export type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d';
export type Interval = '1m' | '5m' | '15m' | '1h' | '1d';

export type Metric =
  | 'revenue'
  | 'price'
  | 'demand'
  | 'orders'
  | 'margin'
  | 'inventory'
  | 'conversion'
  | 'traffic'
  | 'price_changes'
  | 'api_requests'
  | 'latency';

export type StrategyMode = 'draft' | 'validated' | 'shadow' | 'active' | 'paused';
/** What `/strategies/promote` accepts for `mode`. */
export type PromoteMode = 'validated' | 'shadow' | 'active' | 'paused';

export type Severity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';
export type AlertAction = 'ack' | 'resolve' | 'dismiss';

export type Operator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'not_in' | 'between';
export type AdjustmentType = 'percentage' | 'absolute' | 'multiplier' | 'set_price' | 'formula';
/** How a formula's computed number is applied. */
export type FormulaMode = 'percent' | 'amount' | 'price';

export type UploadKind = 'historical' | 'items' | 'competitor';
export type ChaosScenario = string;

/**
 * One condition in a rule, in the shape `/rules/create` expects.
 *
 * The key is `operator`, not `op` — the server reads `c.get("operator")` and
 * reports "unsupported operator 'None'" for anything else, which is an easy
 * mistake to make and a confusing error to receive.
 *
 * `in` and `not_in` put their list in `value` itself; there is no separate list
 * field. `between` is the only operator that uses `value2`.
 */
export interface Clause {
  field: string;
  operator: Operator;
  value: string | number | boolean | (string | number)[];
  value2?: number;
}

/**
 * A rule's effect on the price.
 *
 * `value` must be POSITIVE. Direction is carried separately, and the server
 * rejects a negative value outright ("use direction to decrease") — so a
 * decrease is `{value: 8, direction: 'decrease'}`, never `{value: -8}`.
 */
export interface Adjustment {
  type: AdjustmentType;
  value: number;
  direction: 'increase' | 'decrease';
  /** type === 'formula' only: a safe arithmetic expression over the signals. */
  expr?: string;
  formula_mode?: FormulaMode;
}

/** One attribute in a project's domain schema. */
export interface SchemaAttribute {
  id: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  enum?: string[];
}

/** One context signal the engine can read in a rule. */
/**
 * One field in a project's schema.
 *
 * `scope` decides where the value lives and how it reaches the engine:
 *   item    per-product, stored on the item (its inventory, capacity…)
 *   global  one value for the whole project (site traffic, market demand…)
 *   request supplied on the price call, never stored (customer tier, quantity…)
 * It is optional for backward compatibility: a field with no scope is `item`.
 */
export type SignalScope = 'item' | 'global' | 'request';

export interface SchemaSignal {
  id: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'enum';
  scope?: SignalScope;
  min?: number;
  max?: number;
  enum?: string[];
  description?: string;
}

/** The whole domain definition, sent to `/domain/save` as one JSON param. */
export interface DomainSchema {
  domain_name: string;
  entity_label: string;
  attributes: SchemaAttribute[];
  context_signals: SchemaSignal[];
}

export interface Guardrails {
  min_price?: number | null;
  max_price?: number | null;
  max_increase_pct?: number | null;
  max_decrease_pct?: number | null;
  min_margin_pct?: number | null;
}

/* ===========================================================================
   Auth — the only unauthenticated calls
   =========================================================================== */

/**
 * What `/auth/complete-profile` returns.
 *
 * Hand-written rather than generated: the only capture of this endpoint was
 * truncated (it carries the whole domain-template catalog), and it can only be
 * called once per account, so it cannot be re-captured against an existing one.
 * The shape is taken from the handler in backend/app/routers/auth.py.
 */
export interface CompleteProfileResult {
  ok: boolean;
  tenant_id: string;
  company_name: string;
  service_type: string;
  currency: string;
  registration_complete: boolean;
  next_step: string;
  /** The domain template matching the chosen industry, when one exists. */
  suggested_template: DomainTemplate | null;
  domain_templates: DomainTemplate[];
}

/** A starting point for a project's schema. Templates are never restrictions. */
export type DomainTemplate = CatalogResponse['catalog']['domain_templates'][number];


/**
 * `/analytics/portfolio` — account-wide, not project-scoped.
 *
 * Hand-written rather than generated: the endpoint is newer than the last
 * capture run. Shape mirrors the handler in backend/app/routers/analytics.py.
 */
export interface PortfolioResponse {
  ok: boolean;
  range: string;
  /** '1h' or '1d' — long windows are bucketed by day. */
  interval?: string;
  projects: { total: number; live: number; draft: number; paused: number };
  totals: {
    decisions: number;
    price_changes: number;
    /** Sum of prices QUOTED, not confirmed sales. See `priced_value_basis`. */
    priced_value: number;
    priced_margin?: number;
    items: number;
    change_rate_pct: number;
  };
  /** Null when the previous period had no activity to compare against. */
  trend: { decisions: number | null; priced_value: number | null };
  series: { t: number; decisions: number; price_changes: number; priced_value: number }[];
  health: {
    degraded: number;
    fallbacks: number;
    guardrail_blocks: number;
    healthy: boolean;
  };
  /**
   * Projects whose engine could not run, worst first. Empty when all is well —
   * which is the normal case, and what makes it usable as an alert.
   */
  attention: {
    project_id: string;
    name: string;
    domain_name: string;
    mode: string;
    currency: string;
    decisions: number;
    price_changes: number;
    priced_value: number;
    fallbacks: number;
    degraded: number;
  }[];
  busiest: {
    project_id: string;
    name: string;
    domain_name: string;
    mode: string;
    currency: string;
    decisions: number;
    price_changes: number;
    priced_value: number;
  }[];
  domains: string[];
  /** Null when projects use different currencies — the totals cannot be summed. */
  currency: string | null;
  priced_value_basis?: string;
  note?: string;
}

export const authApi = {
  /** Step 1: creates the login identity. No company yet, so no tenant yet. */
  signup: (email: string, password: string, name?: string) =>
    pub<SignupResponse>('/auth/signup', { email, password, name }),

  login: (email: string, password: string) =>
    pub<LoginResponse>('/auth/login', { email, password }),

  /**
   * Step 2: attaches the company and creates the tenant.
   *
   * Until this succeeds the session has no tenant, and every endpoint other
   * than this one answers 403. The app routes to onboarding on that basis
   * rather than guessing.
   */
  completeProfile: (p: {
    company_name: string;
    service_type: string;
    currency?: string;
    country?: string;
    company_size?: string;
  }) => auth<CompleteProfileResult>('/auth/complete-profile', { ...p }),

  /**
   * The bootstrap call. One request returns the user, the tenant, every
   * project and the full dropdown catalog — so the app shell needs exactly one
   * round trip before it can render, instead of four.
   */
  me: (opts?: RequestOptions) => auth<MeResponse>('/auth/me', {}, opts),

  /** The same catalog, for screens reachable before sign-in. */
  catalog: () => pub<CatalogResponse>('/meta/catalog'),

  health: () => pub<HealthResponse>('/health'),
};

/* ===========================================================================
   Projects
   =========================================================================== */

export const projectsApi = {
  create: (p: {
    name: string;
    domain_name: string;
    entity_label?: string;
    currency?: string;
    template_id?: string;
  }) => auth<CreateProjectResponse>('/projects/create', { ...p }),

  list: (opts?: RequestOptions) => auth<ProjectListResponse>('/projects/list', {}, opts),

  get: (project_id: string, opts?: RequestOptions) =>
    auth<ProjectDetailResponse>('/projects/get', { project_id }, opts),

  /**
   * Permanently delete a project and everything in it (draft or live).
   *
   * Clears the project record, its API key, items, rules, strategies, context,
   * decisions and chat. Cannot be undone — always confirm first.
   */
  remove: (project_id: string, opts?: RequestOptions) =>
    auth<{ ok: boolean; deleted: boolean; project_id: string; removed: Record<string, number> }>(
      '/projects/delete', { project_id }, opts,
    ),

  /** The no-code domain builder. The schema travels as one JSON parameter. */
  saveDomain: (project_id: string, schema: DomainSchema) =>
    auth<SaveDomainResponse>('/domain/save', { project_id, schema: json(schema) }),

  /**
   * Project-level safety limits.
   *
   * THIS IS A FULL REPLACE, not a patch. The server stores exactly the set of
   * limits it receives, so any limit left out is CLEARED — saving only
   * `max_price` would silently remove the price floor and every movement cap.
   *
   * Callers must therefore always send the complete set they want to end up
   * with. Both call sites (the project wizard and settings) build their payload
   * from every field on the form for this reason.
   *
   * `null` means "do not enforce this one" and is sent by omitting the
   * parameter — the server's float parser rejects an empty string with a 422,
   * so a blank field cannot be passed through as `''`.
   */
  saveGuardrails: (project_id: string, g: Guardrails) =>
    auth<SaveGuardrailsResponse>('/guardrails/save', { project_id, ...numeric(g) }),

  rotateKey: (project_id: string) =>
    auth<ProjectDetailResponse>('/apikeys/rotate', { project_id }),
};

/**
 * Keep only the limits that have a real number.
 *
 * `null` and `undefined` are both dropped: the endpoint is a full replace, so
 * an absent parameter already means "not enforced". Sending `''` instead would
 * fail the server's float validation with a 422 rather than clearing anything.
 */
function numeric(g: Guardrails): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(g)) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    out[k] = v;
  }
  return out;
}

/* ===========================================================================
   Items
   =========================================================================== */

export const itemsApi = {
  create: (p: {
    project_id: string;
    item_id: string;
    name: string;
    base_price: number;
    cost?: number;
    attributes?: Record<string, unknown>;
    /** Initial values for this item's item-scope signals (inventory, etc.). */
    signals?: Record<string, number | string>;
    /**
     * Replace an item that already exists.
     *
     * Without this the server answers 409 rather than overwriting silently —
     * re-running an import used to rewrite prices a user had since edited by
     * hand, with nothing to notice it by.
     */
    overwrite?: boolean;
  }) =>
    auth<CreateItemResponse>('/items/create', {
      project_id: p.project_id,
      item_id: p.item_id,
      name: p.name,
      base_price: p.base_price,
      cost: p.cost,
      attributes: json(p.attributes),
      signals: json(p.signals),
      overwrite: p.overwrite,
    }),

  /**
   * Change an existing item.
   *
   * `item_id` is deliberately absent from the changeable fields: it is the key
   * every decision, context row and snapshot is filed under, and what the
   * caller's own backend asks for prices with.
   */
  update: (p: {
    project_id: string;
    item_id: string;
    name?: string;
    base_price?: number;
    cost?: number | null;
    attributes?: Record<string, unknown>;
    /** Item-scope signal values to set on this product. */
    signals?: Record<string, number | string>;
  }) =>
    auth<CreateItemResponse>('/items/update', {
      project_id: p.project_id,
      item_id: p.item_id,
      name: p.name,
      base_price: p.base_price,
      // 0 is how the server is told to clear a cost, so null maps to it rather
      // than being dropped as an absent parameter.
      cost: p.cost === null ? 0 : p.cost,
      attributes: json(p.attributes),
      signals: json(p.signals),
    }),

  /** Removes the item and its live context. Past decisions are kept. */
  remove: (project_id: string, item_id: string) =>
    auth<{ ok: boolean; item_id: string; items_remaining: number }>('/items/delete', {
      project_id,
      item_id,
    }),

  list: (
    project_id: string,
    p: { search?: string; limit?: number; cursor?: string } = {},
    opts?: RequestOptions,
  ) => auth<ItemListResponse>('/items/list', { project_id, ...p }, opts),

  get: (project_id: string, item_id: string, opts?: RequestOptions) =>
    auth<ItemDetailResponse>('/items/get', { project_id, item_id }, opts),
};

/* ===========================================================================
   Rules
   =========================================================================== */

export const rulesApi = {
  create: (p: {
    project_id: string;
    name: string;
    conditions: Clause[];
    adjustment: Adjustment;
    logic?: 'all' | 'any';
    priority?: number;
    stackable?: boolean;
    conflict_group?: string;
    enabled?: boolean;
    /** Optional calendar window, epoch ms. The rule applies only inside it. */
    starts_at?: number | null;
    ends_at?: number | null;
  }) =>
    auth<CreateRuleResponse>('/rules/create', {
      project_id: p.project_id,
      name: p.name,
      conditions: json(p.conditions),
      adjustment: json(p.adjustment),
      logic: p.logic,
      priority: p.priority,
      stackable: p.stackable,
      conflict_group: p.conflict_group,
      enabled: p.enabled,
      starts_at: p.starts_at ?? undefined,
      ends_at: p.ends_at ?? undefined,
    }),

  /** Switch one rule on or off, live — re-syncs the active strategy. */
  toggle: (project_id: string, rule_id: string, enabled: boolean) =>
    auth<{ ok: boolean; rule_id: string; enabled: boolean; in_active_strategy: boolean; effective: string }>(
      '/rules/toggle', { project_id, rule_id, enabled },
    ),

  /** Permanently delete a rule — drops it from the live strategy and re-syncs. */
  remove: (project_id: string, rule_id: string, opts?: RequestOptions) =>
    auth<{ ok: boolean; rule_id: string; deleted: boolean; in_active_strategy: boolean; effective: string }>(
      '/rules/delete', { project_id, rule_id }, opts,
    ),

  /** Updating a rule creates a new version of it; nothing is edited in place. */
  update: (p: {
    project_id: string;
    rule_id: string;
    name?: string;
    conditions?: Clause[];
    adjustment?: Adjustment;
    logic?: 'all' | 'any';
    priority?: number;
    stackable?: boolean;
    conflict_group?: string;
    enabled?: boolean;
    starts_at?: number | null;
    ends_at?: number | null;
    /** Explicitly remove the rule's date window. */
    clear_window?: boolean;
  }) =>
    auth<UpdateRuleResponse>('/rules/update', {
      project_id: p.project_id,
      rule_id: p.rule_id,
      name: p.name,
      conditions: json(p.conditions),
      adjustment: json(p.adjustment),
      logic: p.logic,
      priority: p.priority,
      stackable: p.stackable,
      conflict_group: p.conflict_group,
      enabled: p.enabled,
      starts_at: p.starts_at ?? undefined,
      ends_at: p.ends_at ?? undefined,
      clear_window: p.clear_window,
    }),

  list: (project_id: string, include_disabled?: boolean, opts?: RequestOptions) =>
    auth<RuleListResponse>('/rules/list', { project_id, include_disabled }, opts),

  /**
   * Static conflict detection, run before a strategy is allowed live.
   *
   * Omitting `rule_ids` checks every rule in the project; passing a subset
   * checks the set a strategy is about to compile.
   */
  conflicts: (project_id: string, rule_ids?: string[], opts?: RequestOptions) =>
    auth<RuleConflictsResponse>('/rules/conflicts', { project_id, rule_ids: csv(rule_ids) }, opts),
};

/* ===========================================================================
   Strategies and their lifecycle
   =========================================================================== */

export interface PendingPublish {
  approval_id: string;
  strategy_id: string;
  strategy_name?: string | null;
  version: string;
  requested_by: string;
  requested_at: number;
}

export const strategiesApi = {
  /** Turn the "require approval to publish" gate on or off for a project. */
  setApprovalPolicy: (project_id: string, require: boolean) =>
    auth<{ ok: boolean; require_approval: boolean }>('/strategies/approval-policy', {
      project_id,
      require,
    }),

  /** The publish request currently awaiting approval, if any. */
  pendingPublish: (project_id: string, opts?: RequestOptions) =>
    auth<{ ok: boolean; pending: PendingPublish | null }>(
      '/strategies/publish/pending', { project_id }, opts,
    ),

  approvePublish: (project_id: string, approval_id: string, note?: string) =>
    auth<{ ok: boolean; published: boolean; strategy_id: string; version: string }>(
      '/strategies/publish/approve', { project_id, approval_id, note },
    ),

  rejectPublish: (project_id: string, approval_id: string, note?: string) =>
    auth<{ ok: boolean; rejected: boolean }>('/strategies/publish/reject', {
      project_id,
      approval_id,
      note,
    }),
  create: (p: {
    project_id: string;
    name: string;
    rule_ids: string[];
    guardrail_override?: Guardrails;
  }) =>
    auth<CreateStrategyResponse>('/strategies/create', {
      project_id: p.project_id,
      name: p.name,
      rule_ids: csv(p.rule_ids),
      guardrail_override: json(p.guardrail_override),
    }),

  update: (p: {
    project_id: string;
    strategy_id: string;
    name?: string;
    rule_ids?: string[];
    guardrail_override?: Guardrails;
  }) =>
    auth<CreateStrategyResponse>('/strategies/update', {
      project_id: p.project_id,
      strategy_id: p.strategy_id,
      name: p.name,
      rule_ids: csv(p.rule_ids),
      guardrail_override: json(p.guardrail_override),
    }),

  list: (project_id: string, opts?: RequestOptions) =>
    auth<StrategyListResponse>('/strategies/list', { project_id }, opts),

  get: (project_id: string, strategy_id: string, version?: string, opts?: RequestOptions) =>
    auth<StrategyDetailResponse>('/strategies/get', { project_id, strategy_id, version }, opts),

  /** The pre-activation gate. A strategy cannot go live without passing. */
  validate: (project_id: string, strategy_id: string, version?: string) =>
    auth<ValidateStrategyResponse>('/strategies/validate', {
      project_id,
      strategy_id,
      version,
    }),

  /** Moves a strategy along DRAFT → VALIDATED → SHADOW → ACTIVE (or PAUSED). */
  promote: (project_id: string, strategy_id: string, mode: PromoteMode, version?: string) =>
    auth<PromoteStrategyResponse>('/strategies/promote', {
      project_id,
      strategy_id,
      mode,
      version,
    }),

  /** Destructive: changes what live traffic is priced with. Always confirm. */
  rollback: (project_id: string, strategy_id: string, to_version: string) =>
    auth<PromoteStrategyResponse>('/strategies/rollback', {
      project_id,
      strategy_id,
      to_version,
    }),
};

/* ===========================================================================
   Simulation, backtest, shadow
   =========================================================================== */

export const simulateApi = {
  /** Price one item under hypothetical signal values. Touches nothing live. */
  whatIf: (p: {
    project_id: string;
    item_id: string;
    overrides?: Record<string, number | string | boolean>;
    strategy_id?: string;
    version?: string;
  }) =>
    auth<WhatIfResponse>('/simulate/whatif', {
      project_id: p.project_id,
      item_id: p.item_id,
      overrides: json(p.overrides),
      strategy_id: p.strategy_id,
      version: p.version,
    }),

  /** The same scenario across several versions of one strategy. */
  compare: (p: {
    project_id: string;
    item_id: string;
    strategy_id: string;
    versions: string[];
    overrides?: Record<string, number | string | boolean>;
  }) =>
    auth<CompareResponse>('/simulate/compare', {
      project_id: p.project_id,
      item_id: p.item_id,
      strategy_id: p.strategy_id,
      versions: csv(p.versions),
      overrides: json(p.overrides),
    }),
};

export const backtestApi = {
  /** Queues a run and returns a job id; results arrive asynchronously. */
  run: (p: {
    project_id: string;
    strategy_id: string;
    date_from: string;
    date_to: string;
    version?: string;
    item_ids?: string[];
  }) =>
    auth<{ ok: boolean; job_id: string; status: string }>('/backtest/run', {
      project_id: p.project_id,
      strategy_id: p.strategy_id,
      date_from: p.date_from,
      date_to: p.date_to,
      version: p.version,
      item_ids: csv(p.item_ids),
    }),

  result: (project_id: string, job_id: string, opts?: RequestOptions) =>
    auth<BacktestResultResponse>('/backtest/result', { project_id, job_id }, opts),

  list: (project_id: string, limit?: number, opts?: RequestOptions) =>
    auth<BacktestListResponse>('/backtest/list', { project_id, limit }, opts),

  /** What a shadow strategy would have charged, against what was charged. */
  shadowComparison: (project_id: string, limit?: number, opts?: RequestOptions) =>
    auth<ShadowComparisonResponse>('/shadow/comparison', { project_id, limit }, opts),
};

/* ===========================================================================
   Decisions — the explainability surface
   =========================================================================== */

export const decisionsApi = {
  list: (
    project_id: string,
    p: { item_id?: string; limit?: number; cursor?: string; changed_only?: boolean } = {},
    opts?: RequestOptions,
  ) => auth<DecisionListResponse>('/decisions/list', { project_id, ...p }, opts),

  /** The stored input snapshot plus every rule outcome, matched or not. */
  replay: (project_id: string, decision_id: string, opts?: RequestOptions) =>
    auth<DecisionReplayResponse>('/decisions/replay', { project_id, decision_id }, opts),

  /**
   * Re-runs the engine on the stored snapshot and compares to the cent.
   *
   * This is the determinism proof, not a formality: it is the difference
   * between claiming decisions are reproducible and demonstrating it.
   */
  verify: (project_id: string, decision_id: string, opts?: RequestOptions) =>
    auth<DecisionVerifyResponse>('/decisions/verify', { project_id, decision_id }, opts),
};

/* ===========================================================================
   Analytics
   =========================================================================== */

export const analyticsApi = {
  overview: (project_id: string, range?: TimeRange, opts?: RequestOptions) =>
    auth<OverviewResponse>('/analytics/overview', { project_id, range }, opts),

  timeseries: (
    project_id: string,
    metric: Metric,
    p: { range?: TimeRange; interval?: Interval } = {},
    opts?: RequestOptions,
  ) => auth<TimeseriesResponse>('/analytics/timeseries', { project_id, metric, ...p }, opts),

  rules: (project_id: string, range?: TimeRange, opts?: RequestOptions) =>
    auth<RuleAnalyticsResponse>('/analytics/rules', { project_id, range }, opts),

  system: (project_id: string, opts?: RequestOptions) =>
    auth<SystemHealthResponse>('/analytics/system', { project_id }, opts),

  /** Every project at once, for the cross-project overview. */
  domains: (opts?: RequestOptions) => auth<DomainsResponse>('/analytics/domains', {}, opts),

  /**
   * Account-wide analytics for the home screen.
   *
   * Deliberately not project-scoped: it answers "how is my pricing doing
   * overall", which no per-project endpoint can without the client fanning out
   * and summing on its own. Long ranges come back bucketed by day.
   */
  portfolio: (range?: TimeRange, opts?: RequestOptions) =>
    auth<PortfolioResponse>('/analytics/portfolio', { range }, opts),

  pipeline: (project_id: string, opts?: RequestOptions) =>
    auth<PipelineResponse>('/analytics/pipeline', { project_id }, opts),
};

/* ===========================================================================
   Live
   =========================================================================== */

export const liveApi = {
  /**
   * One call that paints the entire live dashboard: status, counters, recent
   * events, recent decisions, open alerts and the realtime connection count.
   *
   * This is also the reconnect path — after the socket drops, the UI calls
   * this to resynchronise rather than replaying missed frames, because the
   * socket carries no backlog.
   */
  pulse: (
    project_id: string,
    p: { events?: number; decisions?: number } = {},
    opts?: RequestOptions,
  ) => auth<PulseResponse>('/live/pulse', { project_id, ...p }, opts),

  events: (
    project_id: string,
    p: { limit?: number; item_id?: string; event_type?: string } = {},
    opts?: RequestOptions,
  ) => auth<LiveEventsResponse>('/live/events', { project_id, ...p }, opts),

  decisions: (
    project_id: string,
    p: { limit?: number; changed_only?: boolean } = {},
    opts?: RequestOptions,
  ) => auth<LiveDecisionsResponse>('/live/decisions', { project_id, ...p }, opts),

  connections: (project_id: string, opts?: RequestOptions) =>
    auth<ConnectionsResponse>('/live/connections', { project_id }, opts),
};

/* ===========================================================================
   Alerts, audit, approvals
   =========================================================================== */

export const alertsApi = {
  list: (
    p: {
      project_id?: string;
      severity?: Severity;
      status?: AlertStatus;
      limit?: number;
    } = {},
    opts?: RequestOptions,
  ) => auth<AlertListResponse>('/alerts/list', { ...p }, opts),

  get: (alert_id: string, ts?: number, opts?: RequestOptions) =>
    auth<AlertListResponse>('/alerts/get', { alert_id, ts }, opts),

  ack: (alert_id: string, action: AlertAction, p: { ts?: number; note?: string } = {}) =>
    auth<{ ok: boolean }>('/alerts/ack', { alert_id, action, ...p }),
};

export const auditApi = {
  list: (
    p: { project_id?: string; entity_type?: string; limit?: number; cursor?: string } = {},
    opts?: RequestOptions,
  ) => auth<AuditListResponse>('/audit/list', { ...p }, opts),
};

export const approvalsApi = {
  /** Decisions waiting on a human. The home screen's first question. */
  pending: (p: { project_id?: string; limit?: number } = {}, opts?: RequestOptions) =>
    auth<PendingApprovalsResponse>('/approvals/pending', { ...p }, opts),

  get: (approval_id: string, opts?: RequestOptions) =>
    auth<PendingApprovalsResponse>('/approvals/get', { approval_id }, opts),

  /**
   * Records the choice AND executes it — answering with the "Rollback to v2"
   * option really does roll back. The UI must therefore confirm destructive
   * options before calling this, not after.
   */
  answer: (approval_id: string, option_id: string, p: { note?: string } = {}) =>
    auth<{ ok: boolean; [k: string]: unknown }>('/approvals/answer', {
      approval_id,
      option_id,
      source: 'web',
      ...p,
    }),

  history: (p: { project_id?: string; limit?: number } = {}, opts?: RequestOptions) =>
    auth<ApprovalHistoryResponse>('/approvals/history', { ...p }, opts),
};

/* ===========================================================================
   Historical data
   =========================================================================== */

export const dataApi = {
  /**
   * Returns a presigned S3 PUT url. The browser uploads directly to S3, so
   * the file never passes through the API.
   *
   * The signature covers the bucket and key ONLY. Sending extra headers such
   * as Content-Type or x-amz-meta-* with the PUT invalidates it and S3 answers
   * a bare 403 — so `upload()` below deliberately sends no headers at all.
   */
  uploadUrl: (project_id: string, filename: string, kind?: UploadKind) =>
    auth<UploadUrlResponse>('/data/upload-url', { project_id, filename, kind }),

  jobs: (project_id: string, limit?: number, opts?: RequestOptions) =>
    auth<DataJobListResponse>('/data/jobs', { project_id, limit }, opts),

  job: (project_id: string, job_id: string, opts?: RequestOptions) =>
    auth<DataJobResponse>('/data/job', { project_id, job_id }, opts),

  /** PUT the file to the presigned url. No headers — see above. */
  async upload(url: string, file: File, onProgress?: (pct: number) => void): Promise<void> {
    // XMLHttpRequest rather than fetch, purely for upload progress: fetch has
    // no equivalent, and a multi-megabyte CSV with no progress bar feels broken.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
      xhr.send(file);
    });
  },
};

/* ===========================================================================
   AI assistant — drafts only, never live control
   =========================================================================== */

export const aiApi = {
  /**
   * Natural language in, a DRAFT configuration out.
   *
   * The response is never applied automatically. Every caller surfaces it as
   * an explicitly labelled draft for a human to review, and the only way it
   * reaches the engine is through the ordinary rule/strategy endpoints.
   */
  configure: (project_id: string, prompt: string, use_cache?: boolean) =>
    auth<AiConfigureResponse>('/ai/configure', { project_id, prompt, use_cache }, {
      // Generation is slower than a data read, and the default timeout would
      // cut off a legitimate response.
      timeoutMs: 45_000,
    }),

  /**
   * Draft a battery of pricing test cases for the Playground.
   *
   * The cases are a HYPOTHESIS — the AI proposes inputs and an expected price;
   * the Playground runs the real engine (simulation) and shows any difference.
   */
  testcases: (project_id: string, count?: number, focus?: string) =>
    auth<AiTestcasesResponse>('/ai/testcases', { project_id, count, focus }, {
      timeoutMs: 60_000,
    }),

  /**
   * Draft a whole SET of profit-aware, guardrail-respecting rules.
   *
   * The multi-rule counterpart to `configure` (one rule from one sentence). The
   * rules are DRAFTS — they populate the builder for the user to review, edit
   * and save. Nothing is activated here.
   */
  bestRules: (project_id: string, focus?: string) =>
    auth<AiBestRulesResponse>('/ai/rules/best', { project_id, focus }, {
      timeoutMs: 60_000,
    }),

  /** Advisory only. Nothing in the pricing path consumes this. */
  forecast: (project_id: string, item_id: string, horizon?: number, opts?: RequestOptions) =>
    auth<ForecastResponse>('/ai/forecast', { project_id, item_id, horizon }, opts),

  health: (opts?: RequestOptions) => auth<AiHealthResponse>('/ai/health', {}, opts),

  /**
   * The schema-design conversation for a project, oldest first.
   *
   * The transcript is tied to the project, not the browser — reopening the
   * wizard loads every earlier message so the thread continues where it left
   * off. Messages carry the raw reply; the caller strips §directives for
   * display just as it does while streaming.
   */
  chatHistory: (project_id: string, opts?: RequestOptions) =>
    auth<AiChatHistoryResponse>('/ai/chat/history', { project_id }, opts),
};

/* ===========================================================================
   Demo controls — for driving the live dashboard during a walkthrough
   =========================================================================== */

export const demoApi = {
  traffic: (p: {
    project_id: string;
    events_per_sec?: number;
    duration?: number;
    item_ids?: string[];
    pattern?: 'steady' | 'spike' | 'ramp' | 'drop';
  }) =>
    auth<DemoTrafficResponse>(
      '/demo/traffic',
      {
        project_id: p.project_id,
        events_per_sec: p.events_per_sec,
        duration: p.duration,
        item_ids: csv(p.item_ids),
        pattern: p.pattern,
      },
      { timeoutMs: 60_000 },
    ),

  chaos: (project_id: string, scenario: ChaosScenario, duration?: number) =>
    auth<{ ok: boolean; [k: string]: unknown }>('/demo/chaos', {
      project_id,
      scenario,
      duration,
    }),
};

/* ===========================================================================
   Runtime API — what a customer's application calls
   ---------------------------------------------------------------------------
   These are authenticated by the project API key in the PATH, not by a session
   token. The web app calls them only to demonstrate the integration on the API
   page, which is why the key is a parameter here rather than ambient state.
   =========================================================================== */

export const runtimeApi = {
  price: (project_key: string, item_id: string, opts?: RequestOptions) =>
    pub<PriceResponse>(`/v1/p/${encodeURIComponent(project_key)}/price`, { item_id }, opts),

  bulkPrice: (project_key: string, item_ids: string[], opts?: RequestOptions) =>
    pub<BulkPriceResponse>(
      `/v1/p/${encodeURIComponent(project_key)}/price/bulk`,
      { item_ids: csv(item_ids) },
      opts,
    ),

  /** The customer-facing "why is it this price" response. */
  explain: (project_key: string, decision_id: string, opts?: RequestOptions) =>
    pub<{ ok: boolean; [k: string]: unknown }>(
      `/v1/p/${encodeURIComponent(project_key)}/explain`,
      { decision_id },
      opts,
    ),

  /**
   * Send one business event.
   *
   * Arbitrary signals ride along as `signal_<id>=<value>` parameters, which is
   * what keeps the platform domain-agnostic at the ingestion boundary: a
   * co-working space can push `signal_desk_occupancy` without any backend
   * change.
   */
  event: (
    project_key: string,
    p: {
      item_id: string;
      event_type: string;
      event_id?: string;
      quantity?: number;
      value?: number;
      signals?: Record<string, number>;
    },
    opts?: RequestOptions,
  ) => {
    const params: Params = {
      item_id: p.item_id,
      event_type: p.event_type,
      event_id: p.event_id,
      quantity: p.quantity,
      value: p.value,
    };
    for (const [k, v] of Object.entries(p.signals ?? {})) params[`signal_${k}`] = v;
    return pub<{ ok: boolean; [k: string]: unknown }>(
      `/v1/t/${encodeURIComponent(project_key)}/event`,
      params,
      opts,
    );
  },
};

/** Everything, for the places that would rather import one object. */
export const api = {
  auth: authApi,
  projects: projectsApi,
  items: itemsApi,
  rules: rulesApi,
  strategies: strategiesApi,
  simulate: simulateApi,
  backtest: backtestApi,
  decisions: decisionsApi,
  analytics: analyticsApi,
  live: liveApi,
  alerts: alertsApi,
  audit: auditApi,
  approvals: approvalsApi,
  data: dataApi,
  ai: aiApi,
  demo: demoApi,
  runtime: runtimeApi,
};
