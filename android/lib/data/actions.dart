import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/cache/cache_store.dart';
import 'providers.dart';
import 'repository.dart';

final projectActionsProvider = Provider<ProjectActions>((ref) => ProjectActions(ref));

/// Every write the app can make. Each one updates the cache optimistically so
/// the UI responds the instant you tap, then reconciles with the server; on
/// failure it revalidates the real state so the screen never lies.
class ProjectActions {
  ProjectActions(this._ref);
  final Ref _ref;

  CacheStore get _store => _ref.read(cacheStoreProvider);
  Fetchers get _f => _ref.read(fetchersProvider);

  Future<void> toggleRule(String pid, String ruleId, bool enabled) async {
    final key = CacheKeys.rulesGuards(pid);
    final snapshot = _store.peekJson(key);
    // Optimistic: flip the rule in the cached blob so the switch animates now.
    if (snapshot is Map && snapshot['rules'] is List) {
      final rules = (snapshot['rules'] as List).map((r) {
        if (r is Map && r['rule_id'] == ruleId) {
          return {...r, 'enabled': enabled};
        }
        return r;
      }).toList();
      _store.put(key, {...snapshot, 'rules': rules});
    }
    try {
      await _f.toggleRule(pid, ruleId, enabled);
    } catch (e) {
      await _store.refresh(key, () => _f.rulesGuards(pid)); // restore truth
      rethrow;
    }
  }

  Future<void> setLive(String pid, String strategyId, bool live) async {
    await _f.promote(pid, strategyId, live ? 'active' : 'paused');
    await Future.wait([
      _store.refresh(CacheKeys.strategies(pid), () => _f.strategies(pid)),
      _store.refresh(CacheKeys.home, _f.home),
    ]);
  }

  Future<void> ackAlert(String pid, String alertId, String action, int ts) async {
    await _f.ackAlert(pid, alertId, action, ts);
    await Future.wait([
      _store.refresh(CacheKeys.alerts(pid), () => _f.alerts(pid)),
      _store.refresh(CacheKeys.home, _f.home),
    ]);
  }

  Future<void> answerDecision(String approvalId, String optionId) async {
    await _f.answerDecision(approvalId, optionId);
    await _store.refresh(CacheKeys.home, _f.home); // pending decision clears
  }

  Future<void> refreshHome() => _store.refresh(CacheKeys.home, _f.home);

  Future<void> saveGuardrails(String pid, Map<String, dynamic> g) async {
    await _f.saveGuardrails(pid, g);
    await _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid));
  }

  Future<void> setApprovalPolicy(String pid, bool require) =>
      _f.setApprovalPolicy(pid, require);

  /// Full data wipe (decisions, analytics, alerts, audit) — keeps config.
  Future<void> resetData(String pid) async {
    await _f.resetData(pid);
    _store.invalidate(CacheKeys.liveDecisions(pid));
    await Future.wait([
      _store.refresh(CacheKeys.overview(pid, '24h'), () => _f.overview(pid, '24h')),
      _store.refresh(CacheKeys.alerts(pid), () => _f.alerts(pid)),
      _store.refresh(CacheKeys.audit(pid), () => _f.audit(pid)),
      _store.refresh(CacheKeys.liveDecisions(pid), () => _f.liveDecisionsSeed(pid)),
      _store.refresh(CacheKeys.system(pid), () => _f.system(pid)),
      _store.refresh(CacheKeys.home, _f.home),
    ]);
  }
  Future<void> refreshOverview(String pid, String range) => Future.wait([
        _store.refresh(CacheKeys.overview(pid, range), () => _f.overview(pid, range)),
        _store.refresh(CacheKeys.system(pid), () => _f.system(pid)),
      ]);

  Future<void> createRule(String pid,
      {required String name, required List conditions, required Map adjustment, int priority = 50}) async {
    await _f.createRule(pid, name: name, conditions: conditions, adjustment: adjustment, priority: priority);
    await _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid));
  }

  Future<void> updateRule(String pid, String ruleId,
      {required String name, required List conditions, required Map adjustment, int priority = 50}) async {
    await _f.updateRule(pid, ruleId, name: name, conditions: conditions, adjustment: adjustment, priority: priority);
    await _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid));
  }

  Future<void> deleteRule(String pid, String ruleId) async {
    await _f.deleteRule(pid, ruleId);
    await _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid));
  }

  /// Refresh the non-overview project tabs (rules, alerts, audit) together.
  Future<void> refreshTabs(String pid) => Future.wait([
        _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid)),
        _store.refresh(CacheKeys.alerts(pid), () => _f.alerts(pid)),
        _store.refresh(CacheKeys.audit(pid), () => _f.audit(pid)),
        // Re-seed the live decisions feed so a reset (or new traffic) is reflected,
        // not just appended to by the WebSocket.
        _store.refresh(CacheKeys.liveDecisions(pid), () => _f.liveDecisionsSeed(pid)),
      ]);
  Future<void> refreshProject(String pid) => Future.wait([
        _store.refresh(CacheKeys.overview(pid), () => _f.overview(pid)),
        _store.refresh(CacheKeys.rulesGuards(pid), () => _f.rulesGuards(pid)),
        _store.refresh(CacheKeys.alerts(pid), () => _f.alerts(pid)),
      ]);
}
