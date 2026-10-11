import 'dart:convert';

import '../core/api.dart';
import 'models.dart';

/// Cache keys. Keeping them in one place means the resource providers, the
/// mutation handlers and the live WebSocket layer all address the exact same
/// entry — no silent drift between a writer and a reader.
class CacheKeys {
  static const home = 'home';
  static String overview(String p, [String range = '24h']) => 'overview:$p:$range';
  static String priceSeries(String p, String range) => 'series:$p:$range';
  static String signals(String p) => 'signals:$p';
  static String system(String p) => 'system:$p';
  static String rulesGuards(String p) => 'rulesguards:$p';
  static String alerts(String p) => 'alerts:$p';
  static String audit(String p) => 'audit:$p';
  static String items(String p) => 'items:$p';
  static String strategies(String p) => 'strategies:$p';
  static String liveDecisions(String p) => 'live_decisions:$p';
  static String projectPrefix(String p) => ':$p';
}

/// Every network read the app makes, as a function returning the raw JSON that
/// the cache stores. Decoding into models happens in the providers, so the
/// cached bytes stay backend-shaped and survive a model refactor.
class Fetchers {
  Fetchers(this._api, this._token);
  final Api _api;
  final String _token;

  bool get hasToken => _token.isNotEmpty;

  Future<dynamic> home() async =>
      await _api.get('/mobile/home', token: _token);

  Future<dynamic> overview(String pid, [String range = '24h']) async =>
      await _api.get('/analytics/overview',
          params: {'project_id': pid, 'range': range}, token: _token);

  Future<dynamic> priceSeries(String pid, String range) async =>
      await _api.get('/analytics/timeseries',
          params: {'project_id': pid, 'metric': 'price', 'range': range}, token: _token);

  Future<dynamic> schema(String pid) async =>
      await _api.get('/projects/get', params: {'project_id': pid}, token: _token);

  Future<dynamic> system(String pid) async =>
      await _api.get('/analytics/system', params: {'project_id': pid}, token: _token);

  Future<dynamic> approval(String approvalId) async =>
      await _api.get('/approvals/get', params: {'approval_id': approvalId}, token: _token);

  Future<dynamic> projectDetail(String pid) async =>
      await _api.get('/projects/get', params: {'project_id': pid}, token: _token);

  Future<void> saveGuardrails(String pid, Map<String, dynamic> g) async {
    await _api.get('/guardrails/save', params: {'project_id': pid, ...g}, token: _token);
  }

  Future<void> setApprovalPolicy(String pid, bool require) async {
    await _api.get('/strategies/approval-policy',
        params: {'project_id': pid, 'require': require}, token: _token);
  }

  Future<void> resetData(String pid) async {
    await _api.get('/projects/reset-data', params: {'project_id': pid}, token: _token);
  }

  /// Pending approvals across ALL projects (omit project_id).
  Future<dynamic> pendingAll() async =>
      await _api.get('/approvals/pending', token: _token);

  /// Rules and guardrails arrive from two endpoints but live on one screen, so
  /// we fetch both and store them under one key as a single blob.
  Future<dynamic> rulesGuards(String pid) async {
    final rules = await _api.get('/rules/list',
        params: {'project_id': pid}, token: _token);
    final project = await _api.get('/projects/get',
        params: {'project_id': pid}, token: _token);
    final guardrails = (project['guardrails'] ??
            (project['project'] is Map ? project['project']['guardrails'] : null)) ??
        {};
    return {
      'rules': rules['rules'] ?? rules['items'] ?? [],
      'guardrails': guardrails,
    };
  }

  Future<dynamic> alerts(String pid) async =>
      await _api.get('/alerts/list', params: {'project_id': pid}, token: _token);

  Future<dynamic> audit(String pid) async =>
      await _api.get('/audit/list', params: {'project_id': pid}, token: _token);

  Future<dynamic> items(String pid) async =>
      await _api.get('/items/list', params: {'project_id': pid}, token: _token);

  Future<dynamic> strategies(String pid) async =>
      await _api.get('/strategies/list', params: {'project_id': pid}, token: _token);

  /// Seed for the live feed. Best-effort: the real-time truth comes over the
  /// WebSocket; this just gives the screen something to show on first open.
  Future<dynamic> liveDecisionsSeed(String pid) async {
    try {
      final res = await _api.get('/decisions/list',
          params: {'project_id': pid, 'limit': 20}, token: _token);
      final rows = (res['decisions'] ?? res['items'] ?? []) as List;
      return rows
          .whereType<Map>()
          .map((d) => LiveDecision.fromJson({
                'decision_id': d['decision_id'],
                'item_id': d['item_id'],
                'previous_price': d['previous_price'],
                'price': d['final_price'] ?? d['price'],
                'change_pct': d['change_pct'],
                'changed': d['changed'],
                'rules_fired': d['rules_fired'],
                'ts': d['ts'],
              }).toJson())
          .toList();
    } catch (_) {
      return <dynamic>[];
    }
  }

  // ── mutations (also GETs on this backend) ──────────────────────────────
  Future<void> createRule(String pid,
      {required String name, required List conditions, required Map adjustment, int priority = 50}) async {
    await _api.get('/rules/create', params: {
      'project_id': pid, 'name': name,
      'conditions': jsonEncode(conditions), 'adjustment': jsonEncode(adjustment),
      'logic': 'all', 'priority': priority, 'enabled': true, 'go_live': true,
    }, token: _token);
  }

  Future<void> updateRule(String pid, String ruleId,
      {required String name, required List conditions, required Map adjustment, int priority = 50}) async {
    await _api.get('/rules/update', params: {
      'project_id': pid, 'rule_id': ruleId, 'name': name,
      'conditions': jsonEncode(conditions), 'adjustment': jsonEncode(adjustment),
      'logic': 'all', 'priority': priority,
    }, token: _token);
  }

  Future<void> deleteRule(String pid, String ruleId) async {
    await _api.get('/rules/delete', params: {'project_id': pid, 'rule_id': ruleId}, token: _token);
  }

  Future<void> toggleRule(String pid, String ruleId, bool enabled) async {
    await _api.get('/rules/toggle',
        params: {'project_id': pid, 'rule_id': ruleId, 'enabled': enabled},
        token: _token);
  }

  Future<void> promote(String pid, String strategyId, String mode) async {
    await _api.get('/strategies/promote',
        params: {'project_id': pid, 'strategy_id': strategyId, 'mode': mode},
        token: _token);
  }

  Future<void> ackAlert(String pid, String alertId, String action, int ts) async {
    await _api.get('/alerts/ack',
        params: {'project_id': pid, 'alert_id': alertId, 'action': action, 'ts': ts},
        token: _token);
  }

  Future<void> answerDecision(String approvalId, String optionId) async {
    await _api.get('/approvals/answer',
        params: {'approval_id': approvalId, 'option_id': optionId, 'source': 'android'},
        token: _token);
  }

  Future<void> registerDevice(String fcmToken, {bool warnings = true}) async {
    await _api.get('/devices/register',
        params: {'fcm_token': fcmToken, 'platform': 'android', 'warnings_enabled': warnings},
        token: _token);
  }
}
