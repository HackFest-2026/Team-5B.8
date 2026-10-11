// Typed views over the backend's JSON. Every model is tolerant: missing or
// null fields fall back to sensible defaults, because a companion app must
// render *something* even when a partial payload comes back on a weak link.

double _d(dynamic v) => v is num ? v.toDouble() : double.tryParse('$v') ?? 0;
int _i(dynamic v) => v is num ? v.toInt() : int.tryParse('$v') ?? 0;
String _s(dynamic v) => v?.toString() ?? '';
bool _b(dynamic v) => v == true || v == 'true';

class Session {
  final String token, userId, email, name, tenantId, companyName, currency;
  const Session({
    required this.token,
    required this.userId,
    required this.email,
    required this.name,
    required this.tenantId,
    required this.companyName,
    required this.currency,
  });

  bool get registrationComplete => tenantId.isNotEmpty;

  Session copyWith({String? companyName, String? currency, String? name}) => Session(
        token: token,
        userId: userId,
        email: email,
        name: name ?? this.name,
        tenantId: tenantId,
        companyName: companyName ?? this.companyName,
        currency: currency ?? this.currency,
      );

  Map<String, dynamic> toJson() => {
        'token': token, 'user_id': userId, 'email': email, 'name': name,
        'tenant_id': tenantId, 'company_name': companyName, 'currency': currency,
      };

  factory Session.fromStorage(Map<String, dynamic> j) => Session(
        token: _s(j['token']),
        userId: _s(j['user_id']),
        email: _s(j['email']),
        name: _s(j['name']),
        tenantId: _s(j['tenant_id']),
        companyName: _s(j['company_name']),
        currency: _s(j['currency']),
      );
}

class ProjectSummary {
  final String id, name, domainName, mode;
  final int itemCount;
  final int? activeStrategyVersion;
  const ProjectSummary({
    required this.id,
    required this.name,
    required this.domainName,
    required this.mode,
    required this.itemCount,
    this.activeStrategyVersion,
  });

  bool get isLive => mode == 'active';
  bool get isPaused => mode == 'paused' || mode == 'safe';

  factory ProjectSummary.fromJson(Map j) => ProjectSummary(
        id: _s(j['project_id']),
        name: _s(j['name']).isEmpty ? 'Untitled project' : _s(j['name']),
        domainName: _s(j['domain_name']),
        mode: _s(j['mode']).isEmpty ? 'draft' : _s(j['mode']),
        itemCount: _i(j['item_count']),
        activeStrategyVersion:
            j['active_strategy_version'] == null ? null : _i(j['active_strategy_version']),
      );
}

/// The aggregated home payload from `/mobile/home`.
class HomeData {
  final String statusLabel;
  final bool live;
  final int activeProjects, pausedProjects;
  final int decisions24h, priceChanges24h;
  final double changeRatePct, revenue24h, margin24h;
  final int openAlerts, criticalAlerts;
  final List<AlertBrief> latestAlerts;
  final List<ProjectSummary> projects;
  final PendingDecision? pendingDecision;
  final int pendingDecisionCount;

  const HomeData({
    required this.statusLabel,
    required this.live,
    required this.activeProjects,
    required this.pausedProjects,
    required this.decisions24h,
    required this.priceChanges24h,
    required this.changeRatePct,
    required this.revenue24h,
    required this.margin24h,
    required this.openAlerts,
    required this.criticalAlerts,
    required this.latestAlerts,
    required this.projects,
    required this.pendingDecision,
    required this.pendingDecisionCount,
  });

  factory HomeData.fromJson(Map j) {
    final status = (j['status'] as Map?) ?? const {};
    final metrics = (j['metrics'] as Map?) ?? const {};
    final alerts = (j['alerts'] as Map?) ?? const {};
    return HomeData(
      statusLabel: _s(status['label']).isEmpty ? 'No activity' : _s(status['label']),
      live: _b(status['live']),
      activeProjects: _i(status['active_projects']),
      pausedProjects: _i(status['paused_projects']),
      decisions24h: _i(metrics['decisions_24h']),
      priceChanges24h: _i(metrics['price_changes_24h']),
      changeRatePct: _d(metrics['change_rate_pct']),
      revenue24h: _d(metrics['revenue_24h']),
      margin24h: _d(metrics['margin_24h']),
      openAlerts: _i(alerts['open']),
      criticalAlerts: _i(alerts['critical']),
      latestAlerts: ((alerts['latest'] as List?) ?? const [])
          .whereType<Map>()
          .map(AlertBrief.fromJson)
          .toList(),
      projects: ((j['projects'] as List?) ?? const [])
          .whereType<Map>()
          .map(ProjectSummary.fromJson)
          .toList(),
      pendingDecision: j['pending_decision'] is Map
          ? PendingDecision.fromJson(j['pending_decision'] as Map)
          : null,
      pendingDecisionCount: _i(j['pending_decision_count']),
    );
  }
}

class AlertBrief {
  final String id, severity, title, projectId;
  final int ts;
  const AlertBrief(this.id, this.severity, this.title, this.projectId, this.ts);
  factory AlertBrief.fromJson(Map j) => AlertBrief(
        _s(j['alert_id']), _s(j['severity']).isEmpty ? 'info' : _s(j['severity']),
        _s(j['title']), _s(j['project_id']), _i(j['ts']));
}

class Alert {
  final String id, severity, type, title, message, status, itemId;
  final int ts;
  final String? approvalId;
  const Alert({
    required this.id, required this.severity, required this.type,
    required this.title, required this.message, required this.status,
    required this.itemId, required this.ts, this.approvalId,
  });
  bool get isOpen => status == 'open' || status.isEmpty;
  bool get needsDecision => approvalId != null && approvalId!.isNotEmpty;
  factory Alert.fromJson(Map j) => Alert(
        id: _s(j['alert_id']),
        severity: _s(j['severity']).isEmpty ? 'info' : _s(j['severity']),
        type: _s(j['type']),
        title: _s(j['title']),
        message: _s(j['message']),
        status: _s(j['status']).isEmpty ? 'open' : _s(j['status']),
        itemId: _s(j['item_id']),
        ts: _i(j['ts']),
        approvalId: (j['approval_id'] ?? '').toString().isEmpty
            ? null
            : _s(j['approval_id']),
      );
}

class RuleClause {
  final String field, operator;
  final dynamic value, value2;
  const RuleClause(this.field, this.operator, this.value, this.value2);
  factory RuleClause.fromJson(Map j) =>
      RuleClause(_s(j['field']), _s(j['operator']), j['value'], j['value2']);
}

class RuleAdjustment {
  final double value;
  final String type, direction; // percentage|absolute|... , increase|decrease
  const RuleAdjustment(this.value, this.type, this.direction);
  factory RuleAdjustment.fromJson(Map j) =>
      RuleAdjustment(_d(j['value']), _s(j['type']), _s(j['direction']));
  bool get isIncrease => direction == 'increase';
}

class Rule {
  final String id, name, description, explanation, logic, conflictGroup;
  final bool enabled, stackable;
  final int priority, triggerCount;
  final List<RuleClause> clauses;
  final RuleAdjustment? adjustment;
  const Rule({
    required this.id, required this.name, required this.description,
    required this.explanation, required this.logic, required this.conflictGroup,
    required this.enabled, required this.stackable,
    required this.priority, required this.triggerCount,
    required this.clauses, required this.adjustment,
  });
  factory Rule.fromJson(Map j) => Rule(
        id: _s(j['rule_id']),
        name: _s(j['name']).isEmpty ? _s(j['rule_id']) : _s(j['name']),
        description: _s(j['description']),
        explanation: _s(j['explanation']),
        logic: _s(j['logic']).isEmpty ? 'all' : _s(j['logic']),
        conflictGroup: _s(j['conflict_group']),
        enabled: j['enabled'] == null ? true : _b(j['enabled']),
        stackable: j['stackable'] == null ? true : _b(j['stackable']),
        priority: _i(j['priority']),
        triggerCount: _i(j['trigger_count']),
        clauses: ((j['clauses'] as List?) ?? const [])
            .whereType<Map>().map(RuleClause.fromJson).toList(),
        adjustment: j['adjustment'] is Map
            ? RuleAdjustment.fromJson(j['adjustment'] as Map) : null,
      );
  Rule copyWith({bool? enabled}) => Rule(
        id: id, name: name, description: description, explanation: explanation,
        logic: logic, conflictGroup: conflictGroup, enabled: enabled ?? this.enabled,
        stackable: stackable, priority: priority, triggerCount: triggerCount,
        clauses: clauses, adjustment: adjustment,
      );
}

class Guardrails {
  final double? minPrice, maxPrice, maxIncreasePct, maxDecreasePct, minMarginPct;
  const Guardrails({
    this.minPrice, this.maxPrice, this.maxIncreasePct, this.maxDecreasePct, this.minMarginPct,
  });
  bool get isEmpty =>
      [minPrice, maxPrice, maxIncreasePct, maxDecreasePct, minMarginPct].every((v) => v == null);
  static double? _opt(dynamic v) => v == null ? null : _d(v);
  factory Guardrails.fromJson(Map j) => Guardrails(
        minPrice: _opt(j['min_price']),
        maxPrice: _opt(j['max_price']),
        maxIncreasePct: _opt(j['max_increase_pct']),
        maxDecreasePct: _opt(j['max_decrease_pct']),
        minMarginPct: _opt(j['min_margin_pct']),
      );
}

/// Rules + guardrails for one project, read together (one screen in the app).
class RulesAndGuards {
  final List<Rule> rules;
  final Guardrails guardrails;
  const RulesAndGuards(this.rules, this.guardrails);
}

class Item {
  final String id, name;
  final double basePrice, cost;
  const Item(this.id, this.name, this.basePrice, this.cost);
  factory Item.fromJson(Map j) => Item(
        _s(j['item_id']),
        _s(j['name']).isEmpty ? _s(j['item_id']) : _s(j['name']),
        _d(j['base_price'] ?? j['price']),
        _d(j['cost']),
      );
}

class AuditEntry {
  final String action, actor, entityType, entityId, source;
  final int ts;
  const AuditEntry(this.action, this.actor, this.entityType, this.entityId, this.source, this.ts);
  factory AuditEntry.fromJson(Map j) => AuditEntry(
        _s(j['action']), _s(j['actor']), _s(j['entity_type']),
        _s(j['entity_id']), _s(j['source']), _i(j['ts']));
}

/// Overview KPIs for a single project (`/analytics/overview`).
class Overview {
  final double revenue, margin, avgPrice;
  final int decisions, priceChanges, items, guardrailBlocks;
  final double changeRatePct;
  const Overview({
    required this.revenue, required this.margin, required this.avgPrice,
    required this.decisions, required this.priceChanges, required this.items,
    required this.changeRatePct, required this.guardrailBlocks,
  });
  // Each KPI from /analytics/overview is an object {value, change_pct, ...};
  // older/flat payloads send a bare number. Handle both.
  static double _mv(dynamic m) => m is Map ? _d(m['value']) : _d(m);
  static int _mi(dynamic m) => m is Map ? _i(m['value']) : _i(m);
  factory Overview.fromJson(Map j) {
    final k = (j['kpis'] as Map?) ?? (j['totals'] as Map?) ?? j;
    final pc = k['price_changes'];
    return Overview(
      revenue: _mv(k['revenue']),
      margin: _mv(k['margin'] ?? k['priced_margin']),
      avgPrice: _mv(k['avg_price'] ?? k['price']),
      decisions: _mi(k['decisions']),
      priceChanges: _mi(pc),
      items: _mi(k['items'] ?? k['items_covered']),
      changeRatePct: pc is Map && pc['rate_pct'] != null
          ? _d(pc['rate_pct'])
          : _d(k['change_rate_pct']),
      guardrailBlocks: _mi((j['safety'] as Map?)?['guardrail_blocks']),
    );
  }
}

/// A decision awaiting the analyst, rendered as a card with tappable options.
class PendingDecision {
  final String approvalId, projectId, question, severity;
  final List<DecisionOption> options;
  const PendingDecision({
    required this.approvalId, required this.projectId,
    required this.question, required this.severity, required this.options,
  });
  factory PendingDecision.fromJson(Map j) => PendingDecision(
        approvalId: _s(j['approval_id'] ?? j['id']),
        projectId: _s(j['project_id']),
        question: _s(j['question'] ?? j['title'] ?? j['message']),
        severity: _s(j['severity']).isEmpty ? 'warning' : _s(j['severity']),
        options: ((j['options'] as List?) ?? const [])
            .whereType<Map>()
            .map(DecisionOption.fromJson)
            .toList(),
      );
}

class DecisionOption {
  final String id, label, action, consequence;
  final bool recommended;
  const DecisionOption(this.id, this.label, this.action, this.consequence, this.recommended);
  bool get isDanger {
    final a = action.toUpperCase();
    return a.contains('PAUSE') || a.contains('ROLLBACK') || a.contains('REJECT') || a.contains('SAFE');
  }
  factory DecisionOption.fromJson(Map j) => DecisionOption(
        _s(j['option_id'] ?? j['id']),
        _s(j['label'] ?? j['title']),
        _s(j['action'] ?? j['kind'] ?? j['intent']),
        _s(j['consequence']),
        _b(j['recommended']),
      );
}

/// A live pricing decision pushed over the WebSocket `decisions` channel.
class LiveDecision {
  final String id, itemId;
  final double previousPrice, price, changePct;
  final bool changed;
  final List<String> rulesFired;
  final int ts;
  const LiveDecision({
    required this.id, required this.itemId, required this.previousPrice,
    required this.price, required this.changePct, required this.changed,
    required this.rulesFired, required this.ts,
  });
  factory LiveDecision.fromJson(Map j, {int? ts}) => LiveDecision(
        id: _s(j['decision_id']),
        itemId: _s(j['item_id']),
        previousPrice: _d(j['previous_price']),
        price: _d(j['price']),
        changePct: _d(j['change_pct']),
        changed: _b(j['changed']),
        rulesFired:
            ((j['rules_fired'] as List?) ?? const []).map((e) => e.toString()).toList(),
        ts: ts ?? _i(j['ts']),
      );
  Map<String, dynamic> toJson() => {
        'decision_id': id, 'item_id': itemId, 'previous_price': previousPrice,
        'price': price, 'change_pct': changePct, 'changed': changed,
        'rules_fired': rulesFired, 'ts': ts,
      };
}


/// One point on an analytics time-series chart.
class SeriesPoint {
  final int t;
  final double value;
  const SeriesPoint(this.t, this.value);
  factory SeriesPoint.fromJson(Map j) => SeriesPoint(_i(j['t']), _d(j['value']));
}

/// A schema signal, used to populate the rule-builder dropdowns.
class Signal {
  final String id, label, type, scope;
  final List<String> options;
  const Signal({required this.id, required this.label, required this.type, required this.scope, required this.options});
  bool get isEnum => type == 'enum' && options.isNotEmpty;
  bool get isBool => type == 'boolean';
  bool get isNumber => type == 'number';
  factory Signal.fromJson(Map j) => Signal(
        id: _s(j['id']),
        label: _s(j['label']).isEmpty ? _s(j['id']) : _s(j['label']),
        type: _s(j['type']).isEmpty ? 'number' : _s(j['type']),
        scope: _s(j['scope']).isEmpty ? 'item' : _s(j['scope']),
        options: ((j['enum'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );
}


/// Pricing-API response-time percentiles from /analytics/system.
class Latency {
  final double p50, p95, p99;
  const Latency(this.p50, this.p95, this.p99);
  bool get hasData => p50 > 0;
  factory Latency.fromJson(Map j) {
    final api = (j['pricing_api'] as Map?) ?? const {};
    final sm = (api['self_measured'] as Map?) ?? const {};
    return Latency(_d(sm['p50_ms']), _d(sm['p95_ms']), _d(sm['p99_ms']));
  }
}
