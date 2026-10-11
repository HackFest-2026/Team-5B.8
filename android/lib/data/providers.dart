import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/api.dart';
import '../core/cache/cache_store.dart';
import '../core/push.dart';
import 'models.dart';
import 'repository.dart';

// ── infrastructure ─────────────────────────────────────────────────────────
/// A notification the user tapped: open this project's decision.
class DeepLink {
  final String projectId, approvalId;
  const DeepLink(this.projectId, this.approvalId);
}

/// Set by PushService when a notification is tapped; the app navigates on it.
final deepLinkProvider = StateProvider<DeepLink?>((ref) => null);

final apiProvider = Provider<Api>((ref) => Api.create());

final secureStorageProvider =
    Provider<FlutterSecureStorage>((ref) => const FlutterSecureStorage());

/// Overridden in main() with the opened Hive box. The store is a singleton for
/// the whole app lifetime (never auto-disposed), which is what lets screen
/// providers dispose freely and still get an instant cached value on reopen.
final cacheStoreProvider = Provider<CacheStore>(
    (ref) => throw StateError('cacheStoreProvider must be overridden in main()'));

final pushServiceProvider = Provider<PushService>((ref) => PushService(ref));

/// Fetchers carrying the current token. Rebuilds on login/logout, which in turn
/// rebuilds every resource provider that depends on it — so a logout cannot
/// leave a screen fetching with a dead token.
final fetchersProvider = Provider<Fetchers>((ref) {
  final api = ref.watch(apiProvider);
  final token = ref.watch(authControllerProvider).value?.token ?? '';
  return Fetchers(api, token);
});

// ── auth ─────────────────────────────────────────────────────────────────
final authControllerProvider =
    AsyncNotifierProvider<AuthController, Session?>(AuthController.new);

class AuthController extends AsyncNotifier<Session?> {
  FlutterSecureStorage get _storage => ref.read(secureStorageProvider);
  Api get _api => ref.read(apiProvider);
  static const _key = 'session_v1';

  @override
  Future<Session?> build() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    final s = Session.fromStorage(jsonDecode(raw) as Map<String, dynamic>);
    if (s.token.isEmpty) return null;
    // Return the stored session instantly, then refresh profile in the
    // background so cold start never waits on the network.
    unawaited(_refreshProfile(s.token));
    return s;
  }

  Future<Session> _sessionFrom(String token, Map me) async {
    final tenant = (me['tenant'] as Map?) ?? const {};
    final user = (me['user'] as Map?) ?? const {};
    return Session(
      token: token,
      userId: (user['user_id'] ?? '').toString(),
      email: (user['email'] ?? '').toString(),
      name: (user['name'] ?? '').toString(),
      tenantId: (tenant['tenant_id'] ?? '').toString(),
      companyName: (tenant['company_name'] ?? '').toString(),
      currency: (tenant['currency'] ?? 'INR').toString(),
    );
  }

  Future<void> _persist(Session s) async =>
      _storage.write(key: _key, value: jsonEncode(s.toJson()));

  Future<void> _refreshProfile(String token) async {
    try {
      final me = await _api.get('/auth/me', token: token);
      final s = await _sessionFrom(token, me);
      await _persist(s);
      state = AsyncData(s);
      unawaited(ref.read(pushServiceProvider).syncToken());
    } on ApiException catch (e) {
      if (e.isAuth) await logout();
    } catch (_) {/* offline: keep the stored session */}
  }

  Future<void> login(String email, String password) async {
    // The login screen owns its own busy state; we do NOT flip global auth to
    // loading here, or the AuthGate would replace the form with a splash.
    try {
      final res = await _api
          .get('/auth/login', params: {'email': email, 'password': password});
      final token = (res['token'] ?? '').toString();
      if (token.isEmpty) throw ApiException('login failed — no token returned');
      final me = await _api.get('/auth/me', token: token);
      final s = await _sessionFrom(token, me);
      await _persist(s);
      state = AsyncData(s);
      unawaited(ref.read(pushServiceProvider).syncToken());
    } catch (e, st) {
      state = AsyncError(e, st);
      rethrow;
    }
  }

  Future<void> logout() async {
    await _storage.delete(key: _key);
    await ref.read(cacheStoreProvider).clearAll();
    state = const AsyncData(null);
  }
}

// ── cached resources (stale-while-revalidate) ──────────────────────────────
final homeProvider = StreamProvider.autoDispose<Cached<HomeData>>((ref) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  if (!f.hasToken) return const Stream.empty();
  return store.watch<HomeData>(
    CacheKeys.home,
    policy: CachePolicy.home,
    fetcher: f.home,
    decode: (j) => HomeData.fromJson(j as Map),
  );
});

/// Keyed by "pid|range" so each time range caches independently.
final overviewProvider = StreamProvider.autoDispose
    .family<Cached<Overview>, String>((ref, key) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  final parts = key.split('|');
  final pid = parts[0];
  final range = parts.length > 1 ? parts[1] : '24h';
  return store.watch<Overview>(
    CacheKeys.overview(pid, range),
    policy: CachePolicy.overview,
    fetcher: () => f.overview(pid, range),
    decode: (j) => Overview.fromJson(j as Map),
  );
});

/// Price time-series for the overview chart. Keyed by "pid|range".
final priceSeriesProvider = StreamProvider.autoDispose
    .family<Cached<List<SeriesPoint>>, String>((ref, key) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  final parts = key.split('|');
  final pid = parts[0];
  final range = parts.length > 1 ? parts[1] : '24h';
  return store.watch<List<SeriesPoint>>(
    CacheKeys.priceSeries(pid, range),
    policy: CachePolicy.overview,
    fetcher: () => f.priceSeries(pid, range),
    decode: (j) {
      final pts = (j is Map ? (j['points'] ?? []) : j) as List;
      return pts.whereType<Map>().map((m) => SeriesPoint.fromJson(m)).toList();
    },
  );
});

/// Pricing-API response-time percentiles.
final systemProvider = StreamProvider.autoDispose
    .family<Cached<Latency>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<Latency>(
    CacheKeys.system(pid),
    policy: CachePolicy.overview,
    fetcher: () => f.system(pid),
    decode: (j) => Latency.fromJson(j as Map),
  );
});

/// The project's schema signals, for the rule-builder dropdowns.
final schemaSignalsProvider = StreamProvider.autoDispose
    .family<Cached<List<Signal>>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<List<Signal>>(
    CacheKeys.signals(pid),
    policy: CachePolicy.rules,
    fetcher: () => f.schema(pid),
    decode: (j) {
      final sch = (j is Map ? (j['schema'] ?? const {}) : const {}) as Map;
      final sigs = (sch['context_signals'] ?? const []) as List;
      return sigs.whereType<Map>().map((m) => Signal.fromJson(m)).toList();
    },
  );
});

final rulesGuardsProvider = StreamProvider.autoDispose
    .family<Cached<RulesAndGuards>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<RulesAndGuards>(
    CacheKeys.rulesGuards(pid),
    policy: CachePolicy.rules,
    fetcher: () => f.rulesGuards(pid),
    decode: (j) {
      final m = j as Map;
      final rules = ((m['rules'] as List?) ?? const [])
          .whereType<Map>()
          .map(Rule.fromJson)
          .toList();
      return RulesAndGuards(rules, Guardrails.fromJson((m['guardrails'] as Map?) ?? const {}));
    },
  );
});

final alertsProvider =
    StreamProvider.autoDispose.family<Cached<List<Alert>>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<List<Alert>>(
    CacheKeys.alerts(pid),
    policy: CachePolicy.alerts,
    fetcher: () => f.alerts(pid),
    decode: (j) {
      final list = (j is Map ? (j['alerts'] ?? j['items'] ?? []) : j) as List;
      return list.whereType<Map>().map(Alert.fromJson).toList();
    },
  );
});

final auditProvider =
    StreamProvider.autoDispose.family<Cached<List<AuditEntry>>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<List<AuditEntry>>(
    CacheKeys.audit(pid),
    policy: CachePolicy.audit,
    fetcher: () => f.audit(pid),
    decode: (j) {
      final list = (j is Map ? (j['entries'] ?? j['items'] ?? j['audit'] ?? []) : j) as List;
      return list.whereType<Map>().map(AuditEntry.fromJson).toList();
    },
  );
});

final itemsProvider =
    StreamProvider.autoDispose.family<Cached<List<Item>>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<List<Item>>(
    CacheKeys.items(pid),
    policy: CachePolicy.items,
    fetcher: () => f.items(pid),
    decode: (j) {
      final list = (j is Map ? (j['items'] ?? []) : j) as List;
      return list.whereType<Map>().map(Item.fromJson).toList();
    },
  );
});

/// (strategyId, mode) for the active/paused strategy — drives the live toggle.
class ActiveStrategy {
  final String id, mode;
  const ActiveStrategy(this.id, this.mode);
  bool get isLive => mode == 'active';
}

final activeStrategyProvider = StreamProvider.autoDispose
    .family<Cached<ActiveStrategy?>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<ActiveStrategy?>(
    CacheKeys.strategies(pid),
    policy: CachePolicy.rules,
    fetcher: () => f.strategies(pid),
    decode: (j) {
      final list = (j is Map ? (j['strategies'] ?? j['items'] ?? []) : j) as List;
      final maps = list.whereType<Map>().toList();
      Map? pick = maps.cast<Map?>().firstWhere(
            (m) => m?['mode'] == 'active' || m?['mode'] == 'paused',
            orElse: () => maps.isNotEmpty ? maps.first : null,
          );
      if (pick == null) return null;
      return ActiveStrategy(
        (pick['strategy_id'] ?? '').toString(),
        (pick['mode'] ?? 'draft').toString(),
      );
    },
  );
});

/// The live decisions feed: seeded from REST, then fed entirely by the
/// WebSocket layer, which writes new decisions straight into this cache key.
final liveDecisionsProvider = StreamProvider.autoDispose
    .family<Cached<List<LiveDecision>>, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  return store.watch<List<LiveDecision>>(
    CacheKeys.liveDecisions(pid),
    policy: CachePolicy.live,
    fetcher: () => f.liveDecisionsSeed(pid),
    decode: (j) {
      final list = (j as List?) ?? const [];
      return list.whereType<Map>().map((m) => LiveDecision.fromJson(m)).toList();
    },
  );
});
