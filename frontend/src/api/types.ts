// GENERATED — do not edit by hand.
//
// Produced by scripts/gen-types.py from real responses captured off the
// deployed API (scripts/capture-api.py). Shapes and nullability reflect what
// the server actually returned, not an assumption about what it should.
//
// Regenerate:  python3 scripts/capture-api.py && python3 scripts/capture-api2.py
//              python3 scripts/gen-types.py

/** Every response is wrapped: success sets ok=true, failure sets ok=false. */
export interface ApiError {
  code: string;
  message: string;
  /** Some errors attach extra context, e.g. the list of valid values. */
  [key: string]: unknown;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
}

/** Thrown by the client for any non-2xx or ok:false response. */
export class DevNexusError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DevNexusError';
  }
}

/**
 * AI — natural language to a rule
 *
 * GET /ai/configure
 *
 * Shape merged from 2 live response(s).
 */
export interface AiConfigureResponse {
  ok: boolean;
  understood: boolean;
  kind: string | null;
  confidence: string | null;
  suggested_name: string | null;
  config: {
    logic: string;
    clauses: {
      field: string;
      operator: string;
      matched_from: string;
      value_list?: (string | number)[] | null | null;
      value_number: number;
      value_number_2?: number | null | null;
    }[];
    adjustment: {
      type: string;
      value: number;
      direction: string;
    };
    tiers: unknown;
    constraint: unknown;
    schedule: unknown;
    priority: number;
    stackable: boolean;
  } | null;
  interpretation: string[] | null;
  inferred: string[] | null;
  unmapped: string[] | null;
  warnings: string[] | null;
  clarification: string | null;
  status: string | null;
  save_with: string | null;
  next_steps: string[] | null;
  ai: {
    model: string;
    latency_ms: number;
    attempts: number;
    hedged: boolean;
    repaired: boolean;
  } | null;
  cached: boolean | null;
  reasons: string[] | null;
  raw: {
    kind: string;
    confidence: string;
    suggested_name: string;
    logic: string;
    clauses: unknown[];
    adjustment: {
      type: string;
      value: number;
      direction: string;
    };
    tiers: unknown;
    constraint: unknown;
    schedule: unknown;
    priority: number;
    stackable: boolean;
    interpretation: string[];
    inferred: string[];
    unmapped: string[];
    clarification: string | null;
  } | null;
  suggestion: string | null;
  available_signals: {
    id: string;
    label: string;
  }[] | null;
}

/**
 * Gemini key pool and model status
 *
 * GET /ai/health
 *
 * Shape merged from 1 live response(s).
 */
export interface AiHealthResponse {
  ok: boolean;
  healthy: boolean;
  keys: {
    total: number;
    usable: number;
    dead: number;
    cooling: number;
  };
  models: {
    model: string;
    available: boolean;
    cooldown_s: number;
    ok: number;
    fail: number;
  }[];
  capacity_rpm_estimate: number;
  detail: {
    key: string;
    state: string;
    reason?: unknown | null;
    ok: number;
    fail: number;
    avg_ms: number;
    unsupported_models?: unknown | null;
  }[];
  guidance: {
    dead: string;
    cooling: string;
    model_unavailable: string;
  };
}

/**
 * Alert centre
 *
 * GET /alerts/list
 *
 * Shape merged from 2 live response(s).
 */
export interface AlertListResponse {
  ok: boolean;
  count: number;
  alerts: {
    alert_id: string;
    project_id: string;
    severity: string;
    type: string;
    title: string;
    message: string;
    item_id: string;
    decision_id: string | null;
    approval_id: string | null;
    status: string;
    ts: number;
  }[];
  summary: {
    by_status: {
      open: number;
      acked: number;
      resolved: number;
      dismissed: number;
    };
    by_severity: {
      info: number;
      warning: number;
      critical: number;
    };
  };
}

/**
 * Past decisions and their outcomes
 *
 * GET /approvals/history
 *
 * Shape merged from 2 live response(s).
 */
export interface ApprovalHistoryResponse {
  ok: boolean;
  count: number;
  approvals: {
    approval_id: string;
    project_id: string;
    status: string;
    severity: string;
    question: string;
    trigger: string;
    chosen_option_id: string | null;
    chosen_label: string | null;
    chosen_action: string | null;
    followed_recommendation: boolean | null;
    outcome: string | null;
    created_at: number;
    answered_at: number | null;
    answered_by: string | null;
    answered_from: string | null;
    response_seconds: number | null;
  }[];
  stats: {
    answered: number;
    followed_recommendation: number;
    recommendation_follow_rate: number | null;
    median_response_seconds: number | null;
  };
}

/**
 * Audit trail
 *
 * GET /audit/list
 *
 * Shape merged from 1 live response(s).
 */
export interface AuditListResponse {
  ok: boolean;
  count: number;
  entries: {
    audit_id: string;
    action: string;
    actor: string;
    source: string;
    project_id: string;
    entity_type: string;
    entity_id: string;
    old_value?: Record<string, unknown> | null | null;
    new_value: Record<string, unknown>;
    strategy_version?: string | null;
    rule_version?: number | null | null;
    decision_id?: string | null | null;
    note?: string | null | null;
    ts: number;
  }[];
  cursor: string;
  known_actions: string[];
}

/**
 * Backtest history
 *
 * GET /backtest/list
 *
 * Shape merged from 1 live response(s).
 */
export interface BacktestListResponse {
  ok: boolean;
  count: number;
  backtests: {
    job_id: string;
    strategy_id: string;
    version: string;
    status: string;
    window: {
      "from": string;
      to: string;
    };
    revenue_uplift_pct: number | null;
    created_at: number;
    completed_at: number;
  }[];
}

/**
 * Backtest outcome
 *
 * GET /backtest/result
 *
 * Shape merged from 1 live response(s).
 */
export interface BacktestResultResponse {
  ok: boolean;
  job_id: string;
  status: string;
  strategy_id: string;
  version: string;
  window: {
    "from": string;
    to: string;
  };
  comparison: {
    revenue: {
      actual: number;
      simulated: number;
      uplift_pct: number | null;
    };
    margin: {
      actual: number;
      simulated: number;
      uplift_pct: number | null;
    };
    orders: {
      actual: number;
      simulated: number;
      uplift_pct: number | null;
    };
    avg_price: {
      actual: number;
      simulated: number;
      uplift_pct: number | null;
    };
  };
  activity: {
    decisions_replayed: number;
    price_changes: number;
    guardrail_blocks: number;
    items_covered: number;
  };
  rules_triggered: Record<string, number>;
  pricing_correctness: {
    checked: number;
    deterministic: boolean;
    note: string;
    reproduced: number;
  };
  assumptions: {
    price_elasticity: number;
    note: string;
  };
  currency: string;
  completed_at: number;
}

/**
 * Bulk price
 *
 * GET /v1/p/pk_live_kXTKNoCHd2dbgIefmFfLOpwglN4InaSl/price/bulk
 *
 * Shape merged from 1 live response(s).
 */
export interface BulkPriceResponse {
  ok: boolean;
  prices: {
    item_id: string;
    price: number;
    currency: string;
    decision_id: string;
    strategy_version: string;
    previous_price?: number | null | null;
    changed: boolean;
    drivers: { factor: string; impact: string }[];
    degraded: boolean;
    fallback: boolean;
  }[];
  count: number;
}

/**
 * Dropdown options and domain templates
 *
 * GET /meta/catalog
 *
 * Shape merged from 1 live response(s).
 */
export interface CatalogResponse {
  ok: boolean;
  catalog: {
    service_types: {
      id: string;
      label: string;
    }[];
    currencies: {
      id: string;
      label: string;
      symbol: string;
    }[];
    domain_templates: {
      id: string;
      domain_name: string;
      entity_label: string;
      attributes: {
        id: string;
        label: string;
        type: string;
      }[];
      context_signals: {
        id: string;
        label: string;
        type: string;
        min: number;
        max: number;
        description: string;
      }[];
    }[];
    builtin_signals: {
      id: string;
      label: string;
      type: string;
      enum?: string[] | null;
      description: string;
      min?: number | null;
      max?: number | null;
    }[];
    event_types: string[];
    operators: {
      id: string;
      label: string;
    }[];
    adjustment_types: {
      id: string;
      label: string;
    }[];
    strategy_modes: string[];
    alert_severities: string[];
  };
}

/**
 * Chaos — clear all injected faults
 *
 * GET /demo/chaos
 *
 * Shape merged from 1 live response(s).
 */
export interface ChaosResponse {
  ok: boolean;
  scenario: string;
  message: string;
}

/**
 * Compare strategy versions
 *
 * GET /simulate/compare
 *
 * Shape merged from 1 live response(s).
 */
export interface CompareResponse {
  ok: boolean;
  item_id: string;
  strategy_id: string;
  currency: string;
  scenario: Record<string, number | string | boolean>;
  results: {
    version: string;
    price: number;
    recommended_before_guardrails: number;
    rules_fired: string[];
    rule_count: number;
    guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
    drivers: {
      factor: string;
      rule_id: string;
      impact: string;
      amount: number;
    }[];
  }[];
  spread: Record<string, number> | null;
}

/**
 * Connected dashboards
 *
 * GET /live/connections
 *
 * Shape merged from 2 live response(s).
 */
export interface ConnectionsResponse {
  ok: boolean;
  count: number;
  websocket_configured: boolean;
  connections: unknown[];
  channels: string[];
}

/**
 * Create item — attribute not in schema
 *
 * GET /items/create
 *
 * Shape merged from 2 live response(s).
 */
export interface CreateItemResponse {
  ok: boolean;
  item_id: string;
  name: string;
  base_price: number;
  cost: number | null;
  attributes: Record<string, unknown>;
  created: boolean;
  warning: string | null;
}

/**
 * Create project (NO template — fully custom domain)
 *
 * GET /projects/create
 *
 * Shape merged from 1 live response(s).
 */
export interface CreateProjectResponse {
  ok: boolean;
  project_id: string;
  name: string;
  domain_name: string;
  entity_label: string;
  currency: string;
  api_key: string;
  schema: {
    domain_name: string;
    entity_label: string;
    context_signals: unknown[];
    attributes: unknown[];
    version: number;
  };
  endpoints: {
    price: string;
    price_bulk: string;
    explain: string;
    event: string;
    event_batch: string;
  };
  next_step: string;
}

/**
 * Create a rule
 *
 * GET /rules/create
 *
 * Shape merged from 1 live response(s).
 */
export interface CreateRuleResponse {
  ok: boolean;
  rule_id: string;
  rule: {
    project_id: string;
    rule_id: string;
    name: string;
    clauses: {
      field: string;
      operator: string;
      value: number;
      value2?: number | null | null;
    }[];
    adjustment: {
      type: string;
      value: number;
      direction: string;
    };
    logic: string;
    priority: number;
    stackable: boolean;
    conflict_group: string | null;
    enabled: boolean;
    version: string;
    origin: string;
    trigger_count: number;
    created_at: number;
    updated_at: number;
    created_by: string;
  };
  explanation: string;
  conflicts: unknown[];
}

/**
 * Create a strategy
 *
 * GET /strategies/create
 *
 * Shape merged from 1 live response(s).
 */
export interface CreateStrategyResponse {
  ok: boolean;
  strategy_id: string;
  version: string;
  mode: string;
  rule_count: number;
  guardrails: {
    min_price: number;
    max_price: number;
    max_increase_pct: number;
    max_decrease_pct: number;
    min_margin_pct: number;
  };
  next_step: string;
}

/**
 * Upload history and validation summaries
 *
 * GET /data/jobs
 *
 * Shape merged from 1 live response(s).
 */
export interface DataJobListResponse {
  ok: boolean;
  count: number;
  jobs: {
    job_id: string;
    filename: string;
    kind: string;
    status: string;
    rows_total: number;
    rows_valid: number;
    rows_invalid: number;
    rows_warned: number;
    created_at: number;
    completed_at: number;
    error?: string | null | null;
  }[];
}

/**
 * Validation detail and rejected-row download
 *
 * GET /data/job
 *
 * Shape merged from 1 live response(s).
 */
export interface DataJobResponse {
  ok: boolean;
  job_id: string;
  filename: string;
  kind: string;
  status: string;
  summary: {
    rows_total: number;
    rows_valid: number;
    rows_invalid: number;
    rows_warned: number;
    quality_pct: number;
  };
  errors_by_type: Record<string, number>;
  sample_errors: unknown[];
  unknown_columns: unknown[];
  items_affected: number;
  rejected_rows_url: string | null;
  created_at: number;
  completed_at: number;
  error: string | null;
}

/**
 * Recent pricing decisions
 *
 * GET /decisions/list
 *
 * Shape merged from 3 live response(s).
 */
export interface DecisionListResponse {
  ok: boolean;
  count: number;
  decisions: {
    decision_id: string;
    item_id: string;
    price: number;
    previous_price: number | null;
    changed: boolean;
    change_pct: number;
    strategy_version: string;
    rules_fired: string[];
    guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
    degraded: boolean;
    fallback: boolean;
    latency_ms: number;
    ts: number;
  }[];
  cursor: string | null;
  currency: string;
}

/**
 * Replay a decision — the full chain
 *
 * GET /decisions/replay
 *
 * Shape merged from 1 live response(s).
 */
export interface DecisionReplayResponse {
  ok: boolean;
  decision_id: string;
  item_id: string;
  generated_at: number;
  price: {
    final: number;
    recommended_before_guardrails: number;
    previous: Record<string, unknown> | null;
    base: number;
    currency: string;
    changed: boolean;
    change_pct: number;
  };
  strategy: {
    strategy_id: string;
    version: string;
    ruleset_version: string;
  };
  context_used: {
    signals: Record<string, number | string | boolean>;
    signal_age_seconds: Record<string, number>;
    base_price: number;
    cost: number;
    evaluated_at_ms: number;
  };
  rules: {
    matched: boolean;
    priority: number;
    impact_label: string;
    applied: boolean;
    rule_id: string;
    impact_amount: number;
    suppressed_by: string | null;
    name: string;
    clause_results: {
      field: string;
      matched: boolean;
      operator: string;
      expected: number;
      actual: number;
    }[];
    skipped_reason: string | null;
    adjustment: {
      type: string;
      value: number;
      direction: string;
    };
  }[];
  drivers: {
    factor: string;
    amount: number;
    impact: string;
    rule_id: string;
  }[];
  guardrails: {
    configured: {
      max_decrease_pct: number;
      max_price: number;
      max_increase_pct: number;
      min_margin_pct: number;
      min_price: number;
    };
    applied: unknown[];
  };
  degraded: boolean;
  fallback: boolean;
  notes: string[];
  explanation: string;
  verify_url: string;
}

/**
 * PROVE the decision is reproducible
 *
 * GET /decisions/verify
 *
 * Shape merged from 1 live response(s).
 */
export interface DecisionVerifyResponse {
  ok: boolean;
  decision_id: string;
  deterministic: boolean;
  price: {
    original: number;
    recomputed: number;
    difference: number;
    matches: boolean;
  };
  rules_applied: {
    original: string[];
    recomputed: string[];
    matches: boolean;
  };
  verified_against: {
    strategy_version: string;
    ruleset_version: string;
    rule_count: number;
    signals: string[];
  };
  conclusion: string;
}

/**
 * Synthetic traffic generator
 *
 * GET /demo/traffic
 *
 * Shape merged from 1 live response(s).
 */
export interface DemoTrafficResponse {
  ok: boolean;
  events_sent: number;
  pattern: string;
  items_targeted: number;
  note: string;
}

/**
 * Cross-project rollup
 *
 * GET /analytics/domains
 *
 * Shape merged from 2 live response(s).
 */
export interface DomainsResponse {
  ok: boolean;
  project_count: number;
  distinct_domains: string[];
  distinct_domain_count: number;
  totals: {
    items: number;
    decisions: number;
    changes: number;
    revenue: number;
  };
  projects: {
    project_id: string;
    name: string;
    domain_name: string;
    entity_label: string;
    currency: string;
    mode: string;
    items: number;
    signals: number;
    decisions_24h: number;
    price_changes_24h: number;
    revenue_24h: number;
  }[];
  claim: string;
}

/**
 * Send one event
 *
 * GET /v1/t/pk_live_kXTKNoCHd2dbgIefmFfLOpwglN4InaSl/event
 *
 * Shape merged from 5 live response(s).
 */
export interface EventAckResponse {
  ok: boolean;
  accepted: number;
  rejected: number;
  errors: unknown | null;
  note: string;
}

/**
 * Customer-facing explanation
 *
 * GET /v1/p/pk_live_kXTKNoCHd2dbgIefmFfLOpwglN4InaSl/explain
 *
 * Shape merged from 1 live response(s).
 */
export interface ExplainResponse {
  ok: boolean;
  decision_id: string;
  item_id: string;
  price: number;
  previous_price: number | null;
  currency: string;
  changed: boolean;
  change_pct: number;
  drivers: {
    factor: string;
    impact: string;
  }[];
  capped_by_guardrail: boolean;
  guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
  degraded: boolean;
  fallback: boolean;
  explanation: string;
  generated_at: number;
}

/**
 * AI — advisory forecast
 *
 * GET /ai/forecast
 *
 * Shape merged from 1 live response(s).
 */
export interface ForecastResponse {
  ok: boolean;
  item_id: string;
  available: boolean;
  reason: string;
}

/**
 * Health check
 *
 * GET /health
 *
 * Shape merged from 1 live response(s).
 */
export interface HealthResponse {
  ok: boolean;
  status: string;
  stage: string;
  version: string;
}

/**
 * Get item with live context
 *
 * GET /items/get
 *
 * Shape merged from 1 live response(s).
 */
export interface ItemDetailResponse {
  ok: boolean;
  item: {
    item_id: string;
    name: string;
    base_price: number;
    cost: number;
    attributes: Record<string, unknown>;
  };
  context: {
    signals: Record<string, number | string | boolean>;
    signal_age_seconds: Record<string, number>;
    previous_price: number | null;
    updated_at: number;
  };
  last_decision: Record<string, unknown> | null;
  currency: string;
}

/**
 * List and search pricing items
 *
 * GET /items/list
 *
 * Shape merged from 3 live response(s).
 */
export interface ItemListResponse {
  ok: boolean;
  count: number;
  items: {
    item_id: string;
    name: string;
    base_price: number;
    cost: number | null;
    attributes: Record<string, unknown>;
    /** Current values of this item's item-scope signals, keyed by field id. */
    signals: Record<string, number | string>;
    updated_at: number;
  }[];
  cursor: string | null;
  currency: string;
  /** The item-scope fields to render as columns, in schema order. */
  item_fields?: { id: string; label: string; type: string }[];
}

/**
 * Live pricing decision feed
 *
 * GET /live/decisions
 *
 * Shape merged from 1 live response(s).
 */
export interface LiveDecisionsResponse {
  ok: boolean;
  count: number;
  currency: string;
  decisions: {
    decision_id: string;
    item_id: string;
    ts: number;
    age_seconds: number;
    base_price: number;
    previous_price: number;
    price: number;
    changed: boolean;
    change_pct: number;
    signals: Record<string, number | string | boolean>;
    rules_fired: string[];
    rules_detail: {
      suppressed_by: string | null;
      impact_amount: number;
      name: string;
      rule_id: string;
      applied: boolean;
    }[];
    guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
    guardrail_passed: boolean;
    strategy_version: string;
    degraded: boolean;
    fallback: boolean;
    latency_ms: number;
    replay_url: string;
  }[];
  realtime_channel: string;
}

/**
 * Live raw event feed
 *
 * GET /live/events
 *
 * Shape merged from 2 live response(s).
 */
export interface LiveEventsResponse {
  ok: boolean;
  count: number;
  events: {
    ts: number;
    age_seconds: number;
    item_id: string;
    event_type: string;
    quantity: unknown | null;
    value: unknown | null;
    synthetic: boolean;
  }[];
  by_type: {
    view: number;
    something_new: number | null;
    signal_update: number;
    competitor_price: number | null;
  };
  window: string;
  realtime_channel: string;
}

/**
 * Login
 *
 * GET /auth/login
 *
 * Shape merged from 1 live response(s).
 */
export interface LoginResponse {
  ok: boolean;
  user_id: string;
  email: string;
  name: string;
  registration_complete: boolean;
  next_step: string;
  token: string;
  expires_in: number;
  service_types: {
    id: string;
    label: string;
  }[];
  currencies: {
    id: string;
    label: string;
    symbol: string;
  }[];
}

/**
 * Bootstrap the app in one call
 *
 * GET /auth/me
 *
 * Shape merged from 1 live response(s).
 */
export interface MeResponse {
  ok: boolean;
  user: {
    user_id: string;
    email: string;
    name: string;
  };
  registration_complete: boolean;
  catalog: {
    service_types: {
      id: string;
      label: string;
    }[];
    currencies: {
      id: string;
      label: string;
      symbol: string;
    }[];
    domain_templates: {
      id: string;
      domain_name: string;
      entity_label: string;
      attributes: {
        id: string;
        label: string;
        type: string;
      }[];
      context_signals: {
        id: string;
        label: string;
        type: string;
        min: number;
        max: number;
        description: string;
      }[];
    }[];
    builtin_signals: {
      id: string;
      label: string;
      type: string;
      enum?: string[] | null;
      description: string;
      min?: number | null;
      max?: number | null;
    }[];
    event_types: string[];
    operators: {
      id: string;
      label: string;
    }[];
    adjustment_types: {
      id: string;
      label: string;
    }[];
    strategy_modes: string[];
    alert_severities: string[];
  };
  tenant: {
    tenant_id: string;
    company_name: string;
    service_type: string;
    country: string;
    currency: string;
  };
  projects: {
    project_id: string;
    name: string;
    domain_name: string;
    entity_label: string;
    currency: string;
    active_strategy_id?: string | null;
    active_strategy_version?: string | null;
    mode: string;
    item_count: number;
    created_at: number;
  }[];
  next_step: string;
}

/**
 * Android home screen
 *
 * GET /mobile/home
 *
 * Shape merged from 1 live response(s).
 */
export interface MobileHomeResponse {
  ok: boolean;
  status: {
    live: boolean;
    label: string;
    active_projects: number;
    paused_projects: number;
  };
  pending_decision: Record<string, unknown> | null;
  pending_decision_count: number;
  metrics: {
    decisions_24h: number;
    price_changes_24h: number;
    change_rate_pct: number;
    revenue_24h: number;
    margin_24h: number;
  };
  alerts: {
    open: number;
    critical: number;
    latest: unknown[];
  };
  projects: {
    project_id: string;
    name: string;
    domain_name: string;
    mode: string;
    active_strategy_version?: string | null;
    item_count: number;
  }[];
  emergency_actions: {
    pause: string;
    rollback: string;
    answer_decision: string;
  };
}

/**
 * Send a push — info never pushes
 *
 * GET /notify/send
 *
 * Shape merged from 2 live response(s).
 */
export interface NotifyResponse {
  ok: boolean;
  sent: number;
  skipped: boolean | null;
  reason: string;
}

/**
 * Dashboard KPIs
 *
 * GET /analytics/overview
 *
 * Shape merged from 2 live response(s).
 */
export interface OverviewResponse {
  ok: boolean;
  range: string;
  currency: string;
  strategy: {
    active_strategy_id: string;
    version: string;
    mode: string;
  };
  kpis: {
    revenue: {
      value: number;
      change_pct: number | null;
    };
    margin: {
      value: number;
      change_pct: number | null;
      percent: number;
    };
    orders: {
      value: number;
      change_pct: number | null;
    };
    avg_price: {
      value: number;
      change_pct: number | null;
    };
    decisions: {
      value: number;
      change_pct: number | null;
    };
    price_changes: {
      value: number;
      rate_pct: number;
    };
  };
  safety: {
    guardrail_blocks: number;
    fallback_decisions: number;
    degraded_decisions: number;
    healthy: boolean;
  };
  items_covered: number | null;
  note: string;
}

/**
 * Open decisions awaiting this analyst
 *
 * GET /approvals/pending
 *
 * Shape merged from 2 live response(s).
 */
export interface PendingApprovalsResponse {
  ok: boolean;
  count: number;
  has_pending: boolean;
  approvals: {
    approval_id: string;
    project_id: string;
    status: string;
    severity: string;
    trigger: string;
    question: string;
    context_summary: string;
    options: {
      option_id: string;
      label: string;
      action: string;
      consequence: string;
      recommended: boolean;
    }[];
    recommended_option_id: string;
    item_id: string;
    decision_id: string | null;
    strategy_id: string;
    strategy_version: string;
    telemetry: {
      tenant_id: string;
      severity: string;
      anomaly: {
        change_pct: number;
        direction: string;
        to: number;
        item_id: string;
        "from": number;
        signal: string;
      } | null;
      type: string;
      project_id: string;
      reason: string | null;
      decision_id: string | null;
      item_id: string | null;
    };
    created_at: number;
    expires_at: number;
    age_seconds: number;
  }[];
  most_urgent: {
    approval_id: string;
    project_id: string;
    status: string;
    severity: string;
    trigger: string;
    question: string;
    context_summary: string;
    options: {
      option_id: string;
      label: string;
      action: string;
      consequence: string;
      recommended: boolean;
    }[];
    recommended_option_id: string;
    item_id: string;
    decision_id: string | null;
    strategy_id: string;
    strategy_version: string;
    telemetry: {
      tenant_id: string;
      severity: string;
      anomaly: {
        change_pct: number;
        direction: string;
        to: number;
        item_id: string;
        "from": number;
        signal: string;
      };
      type: string;
      project_id: string;
    };
    created_at: number;
    expires_at: number;
    age_seconds: number;
  } | null;
}

/**
 * Event pipeline health
 *
 * GET /analytics/pipeline
 *
 * Shape merged from 1 live response(s).
 */
export interface PipelineResponse {
  ok: boolean;
  healthy: boolean;
  summary: {
    events_per_min: number;
    decisions_per_min: number;
    price_changes_per_min: number;
    total_backlog: number;
    total_dlq: number;
    avg_decision_latency_ms: unknown;
  };
  queues: {
    events: {
      queue: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
      dlq: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
    };
    decisions: {
      queue: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
      dlq: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
    };
    alerts: {
      queue: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
      dlq: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
    };
    data: {
      queue: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
      dlq: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
    };
    backtest: {
      queue: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
      dlq: {
        configured: boolean;
        backlog: number;
        in_flight: number;
        delayed: number;
      };
    };
  };
  data_freshness: {
    stale_after_seconds: number;
    signals: {
      signal: string;
      age_seconds: number;
      median_age_seconds: number;
      stale: boolean;
    }[];
    any_stale: boolean;
    oldest_signal: {
      signal: string;
      age_seconds: number;
      median_age_seconds: number;
      stale: boolean;
    };
  };
  realtime: {
    connected_dashboards: number;
    channels: string[];
    websocket_configured: boolean;
  };
  interpretation: string;
}

/**
 * Price AFTER the signals landed (rule fires)
 *
 * GET /v1/p/pk_live_kXTKNoCHd2dbgIefmFfLOpwglN4InaSl/price
 *
 * Shape merged from 4 live response(s).
 */
export interface PriceResponse {
  ok: boolean;
  price: {
    item_id: string;
    price: number | null;
    currency: string | null;
    decision_id: string | null;
    strategy_version: string | null;
    previous_price: number | null;
    changed: boolean | null;
    drivers: {
      factor: string;
      impact: string;
    }[] | null;
    degraded: boolean | null;
    fallback: boolean | null;
    error: string | null;
  };
}

/**
 * Full project configuration
 *
 * GET /projects/get
 *
 * Shape merged from 1 live response(s).
 */
export interface ProjectDetailResponse {
  ok: boolean;
  project: {
    project_id: string;
    name: string;
    domain_name: string;
    entity_label: string;
    currency: string;
    mode: string;
    active_strategy_id: string;
    active_strategy_version: string;
    shadow_strategy_id: string | null;
    shadow_strategy_version: string | null;
    item_count: number;
    created_at: number;
    require_approval?: boolean;
    pending_publish?: {
      approval_id: string;
      strategy_id: string;
      version: string;
      requested_by: string;
      requested_at: number;
    } | null;
  };
  schema: {
    domain_name: string;
    attributes: {
      type: string;
      id: string;
      label: string;
    }[];
    entity_label: string;
    version: number;
    context_signals: {
      type: string;
      max: number;
      enum?: unknown | null;
      label: string;
      id: string;
      min: number;
      description: string;
    }[];
  };
  guardrails: {
    max_decrease_pct: number;
    max_increase_pct: number;
  };
  builtin_signals: {
    id: string;
    label: string;
    type: string;
    enum?: string[] | null;
    description: string;
    min?: number | null;
    max?: number | null;
  }[];
  api_key: string;
  endpoints: {
    price: string;
    price_bulk: string;
    explain: string;
    event: string;
    event_batch: string;
  };
}

/**
 * All projects for this company
 *
 * GET /projects/list
 *
 * Shape merged from 2 live response(s).
 */
export interface ProjectListResponse {
  ok: boolean;
  count: number;
  projects: {
    project_id: string;
    name: string;
    domain_name: string;
    entity_label: string;
    currency: string;
    mode: string;
    active_strategy_id: string | null;
    active_strategy_version: string | null;
    item_count: number;
    signal_count: number;
    created_at: number;
  }[];
}

/**
 * Promote to SHADOW
 *
 * GET /strategies/promote
 *
 * Shape merged from 2 live response(s).
 */
export interface PromoteStrategyResponse {
  ok: boolean;
  strategy_id: string;
  version: string;
  mode: string;
  effective: string;
  customer_impact: string;
  pending_approval?: boolean;
  approval_id?: string;
}

/**
 * One call that paints the whole live dashboard
 *
 * GET /live/pulse
 *
 * Shape merged from 1 live response(s).
 */
export interface PulseResponse {
  ok: boolean;
  status: {
    mode: string;
    active_strategy_id: string;
    active_version: string;
    /** Null unless a DIFFERENT strategy is genuinely shadowing the live one. */
    shadow_strategy_id?: string | null;
    shadow_version: string | null;
    live: boolean;
  };
  counters: {
    decisions_last_hour: number;
    price_changes_last_hour: number;
    fallbacks_last_hour: number;
    degraded_last_hour: number;
    open_alerts: number;
    critical_alerts: number;
  };
  live_events: {
    ts: number;
    item_id: string;
    event_type: string;
    quantity?: unknown | null;
  }[];
  live_decisions: {
    decision_id: string;
    item_id: string;
    previous_price: number;
    price: number;
    changed: boolean;
    change_pct: number;
    rules_fired: string[];
    guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
    ts: number;
  }[];
  alerts: {
    alert_id: string;
    severity: string;
    title: string;
    approval_id?: string | null;
    needs_decision: boolean;
    ts: number;
  }[];
  currency: string;
  server_time_ms: number;
  realtime: {
    connected: number;
    channels: string[];
  };
}

/**
 * Register a device for push
 *
 * GET /devices/register
 *
 * Shape merged from 1 live response(s).
 */
export interface RegisterDeviceResponse {
  ok: boolean;
  device_id: string;
  registered: boolean;
  new_device: boolean;
  notification_policy: {
    critical: string;
    warning: string;
    info: string;
  };
}

/**
 * Rule health
 *
 * GET /analytics/rules
 *
 * Shape merged from 2 live response(s).
 */
export interface RuleAnalyticsResponse {
  ok: boolean;
  range: string;
  active_rules: number;
  disabled_rules: number;
  total_triggers: number;
  source: string;
  conflicts: {
    type: string;
    severity: string;
    rules: string[];
    message: string;
  }[];
  conflict_count: number;
  blocked_rules: number;
  dead_rules: {
    rule_id: string;
    name: string;
    priority: number;
    triggered: number;
    suppressed: number;
    total_impact: number;
    never_fired: boolean;
  }[];
  rules: {
    rule_id: string;
    name: string;
    priority: number;
    triggered: number;
    suppressed: number;
    total_impact: number;
    never_fired: boolean;
  }[];
}

/**
 * Static conflict detection
 *
 * GET /rules/conflicts
 *
 * Shape merged from 2 live response(s).
 */
export interface RuleConflictsResponse {
  ok: boolean;
  rules_checked: number;
  conflicts: {
    type: string;
    severity: string;
    rules: string[];
    message: string;
    rule_names: string[];
  }[];
  error_count: number;
  warning_count: number;
  safe_to_activate: boolean;
}

/**
 * All rules for this project
 *
 * GET /rules/list
 *
 * Shape merged from 2 live response(s).
 */
export interface RuleListResponse {
  ok: boolean;
  count: number;
  rules: {
    rule_id: string;
    name: string;
    clauses: {
      field: string;
      operator: string;
      value: number;
      value2: number | null;
    }[];
    adjustment: {
      direction: string;
      value: number;
      type: string;
      expr?: string | null;
      formula_mode?: string | null;
    };
    logic: string;
    priority: number;
    stackable: boolean;
    conflict_group: string | null;
    enabled: boolean;
    version: string;
    origin: string;
    trigger_count: number;
    explanation: string;
    starts_at?: number | null;
    ends_at?: number | null;
  }[];
}

/**
 * Save a fully custom domain schema
 *
 * GET /domain/save
 *
 * Shape merged from 1 live response(s).
 */
export interface SaveDomainResponse {
  ok: boolean;
  schema: {
    domain_name: string;
    entity_label: string;
    context_signals: {
      id: string;
      label: string;
      type: string;
      min: number;
      max: number;
      enum?: unknown | null;
      description: string;
    }[];
    attributes: {
      id: string;
      label: string;
      type: string;
    }[];
    version: number;
  };
  signal_count: number;
  attribute_count: number;
  note: string;
}

/**
 * Set guardrails
 *
 * GET /guardrails/save
 *
 * Shape merged from 1 live response(s).
 */
export interface SaveGuardrailsResponse {
  ok: boolean;
  guardrails: {
    min_price: number;
    max_price: number;
    max_increase_pct: number;
    max_decrease_pct: number;
    min_margin_pct: number;
  };
  explanation: string[];
}

/**
 * Service root
 *
 * GET /
 *
 * Shape merged from 1 live response(s).
 */
export interface ServiceInfo {
  ok: boolean;
  service: string;
  description: string;
  docs: string;
  convention: string;
  start_here: string;
}

/**
 * Shadow comparison
 *
 * GET /shadow/comparison
 *
 * Shape merged from 2 live response(s).
 */
export interface ShadowComparisonResponse {
  ok: boolean;
  shadow_active: boolean;
  shadow_strategy: {
    strategy_id: string;
    version: string;
    since: number;
  } | null;
  sample_size: number | null;
  summary: {
    avg_difference_pct: number;
    would_price_higher: number;
    would_price_lower: number;
    would_match: number;
  } | null;
  comparisons: unknown[] | null;
  customer_impact: string | null;
  currency: string | null;
  message: string | null;
}

/**
 * Signup — step 1 (partial registration)
 *
 * GET /auth/signup
 *
 * Shape merged from 1 live response(s).
 */
export interface SignupResponse {
  ok: boolean;
  user_id: string;
  email: string;
  registration_complete: boolean;
  next_step: string;
  token: string;
  expires_in: number;
  service_types: {
    id: string;
    label: string;
  }[];
  currencies: {
    id: string;
    label: string;
    symbol: string;
  }[];
}

/**
 * Strategy detail with its compiled version
 *
 * GET /strategies/get
 *
 * Shape merged from 2 live response(s).
 */
export interface StrategyDetailResponse {
  ok: boolean;
  strategy: {
    strategy_id: string;
    name: string;
    version: string;
    mode: string;
    versions: string[];
  };
  compiled: {
    rule_count: number;
    guardrails: {
      max_increase_pct: number;
      max_decrease_pct: number;
      min_price: number | null;
      min_margin_pct: number | null;
      max_price: number | null;
    };
    compiled_at_ms: number;
  };
  rules: {
    rule_id: string;
    name: string;
    clauses: {
      field: string;
      operator: string;
      value: number;
      value2: number | null;
    }[];
    adjustment: {
      type: string;
      value: number;
      direction: string;
    };
    logic: string;
    priority: number;
    stackable: boolean;
    conflict_group: string | null;
    enabled: boolean;
    version: string;
    explanation: string;
  }[];
  guardrail_explanation: string[];
}

/**
 * List strategies
 *
 * GET /strategies/list
 *
 * Shape merged from 2 live response(s).
 */
export interface StrategyListResponse {
  ok: boolean;
  count: number;
  active_strategy_id: string;
  active_version: string;
  shadow_strategy_id: string | null;
  shadow_version: string | null;
  strategies: {
    strategy_id: string;
    name: string;
    version: string;
    mode: string;
    versions: string[];
    rule_ids: string[];
    rule_count: number;
    updated_at: number;
  }[];
  lifecycle: string[];
}

/**
 * System health & latency
 *
 * GET /analytics/system
 *
 * Shape merged from 2 live response(s).
 */
export interface SystemHealthResponse {
  ok: boolean;
  pricing_api: {
    self_measured: {
      p50_ms: number;
      p95_ms: number;
      p99_ms: number;
      sample_size: number;
      source: string;
      caveat: string;
    };
    cloudwatch: {
      available: boolean;
      note: string;
    };
    requests_last_hour: number;
  };
  pricing_safety: {
    fallback_decisions: number;
    degraded_decisions: number;
    primary_engine: string;
    fallback_strategy: string;
  };
  data_freshness: {
    stale_after_seconds: number;
    signals: {
      signal: string;
      median_age_seconds: number;
      stale: boolean;
    }[];
    any_stale: boolean;
  };
  strategy: {
    mode: string;
    active_version: string;
    shadow_version: string | null;
  };
}

/**
 * Chart data
 *
 * GET /analytics/timeseries
 *
 * Shape merged from 2 live response(s).
 */
export interface TimeseriesResponse {
  ok: boolean;
  metric: string;
  range: string;
  interval: string;
  points: {
    t: number;
    value: number;
  }[];
  stats: {
    min: number;
    max: number;
    avg: number;
    latest: number;
  };
  currency: string;
  source: string;
}

/**
 * Disable a rule
 *
 * GET /rules/update
 *
 * Shape merged from 3 live response(s).
 */
export interface UpdateRuleResponse {
  ok: boolean;
  rule_id: string;
  rule: {
    origin: string;
    project_id: string;
    stackable: boolean;
    adjustment: {
      direction: string;
      type: string;
      value: number;
    };
    version: string;
    enabled: boolean;
    clauses: {
      operator: string;
      value: number;
      value2: number | null;
      field: string;
    }[];
    trigger_count: number;
    conflict_group: string | null;
    logic: string;
    name: string;
    rule_id: string;
    created_at: number;
    updated_at: number;
    created_by: string;
    priority: number;
  };
  explanation: string;
  version_bumped: boolean;
  note: string;
}

/**
 * Get a presigned S3 upload URL
 *
 * GET /data/upload-url
 *
 * Shape merged from 1 live response(s).
 */
export interface UploadUrlResponse {
  ok: boolean;
  job_id: string;
  upload_url: string;
  method: string;
  expires_in: number;
  max_bytes: number;
  instructions: string;
  required_columns: {
    required: string[];
    optional: string[];
    note: string;
  };
}

/**
 * Validate (the pre-activation gate)
 *
 * GET /strategies/validate
 *
 * Shape merged from 1 live response(s).
 */
export interface ValidateStrategyResponse {
  ok: boolean;
  strategy_id: string;
  version: string;
  passed: boolean;
  mode: string;
  errors: string[];
  warnings: {
    type: string;
    severity: string;
    rules: unknown[];
    rule_names: string[];
    message: string;
  }[];
  rule_count: number;
  next_step: string;
}

/**
 * What-if
 *
 * GET /simulate/whatif
 *
 * Shape merged from 1 live response(s).
 */
export interface WhatIfResponse {
  ok: boolean;
  item_id: string;
  currency: string;
  strategy: {
    strategy_id: string;
    version: string;
  };
  current: {
    price: number;
    signals: Record<string, number | string | boolean>;
    rules_fired: string[];
    explanation: string;
  };
  simulated: {
    price: number;
    recommended_before_guardrails: number;
    overrides_applied: Record<string, number | string | boolean>;
    rules_fired: string[];
    guardrails_applied: { rule: string; limit: number | string; before: number; after: number }[];
    drivers: {
      factor: string;
      rule_id: string;
      impact: string;
      amount: number;
    }[];
    explanation: string;
  };
  difference: {
    amount: number;
    percent: number;
    newly_triggered: string[];
    no_longer_triggered: string[];
  };
  note: string;
}


/** One AI-drafted Playground test case. Expected is the AI's estimate. */
export interface AiTestcase {
  id: string;
  title: string;
  description: string;
  item_id: string;
  signals: Record<string, number | string>;
  expected_price: number | null;
  reasoning: string;
  source: 'ai' | 'manual';
}

export interface AiTestcasesResponse {
  ok: boolean;
  cases: AiTestcase[];
  count: number;
  model: string;
  note: string;
}

/**
 * GET /ai/chat/history
 * The stored schema-design transcript for a project. `content` is the raw
 * reply (directives included); the caller strips §lines for display.
 */
export interface AiChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  applied?: string[];
}

export interface AiChatHistoryResponse {
  ok: boolean;
  messages: AiChatHistoryMessage[];
  count: number;
}

/**
 * GET /ai/rules/best
 * A small set of profit-aware, guardrail-respecting rule DRAFTS, plus a
 * one-line summary of the set. Each rule has one condition and an action that is
 * either a percentage change or a formula.
 */
export interface AiBestRule {
  name: string;
  field: string;
  operator: string;
  value: number;
  action: 'increase' | 'decrease' | 'formula';
  percent?: number;
  formula?: string;
  reason: string;
}

export interface AiBestRulesResponse {
  ok: boolean;
  rules: AiBestRule[];
  count: number;
  summary: string;
  model: string;
  note: string;
}
