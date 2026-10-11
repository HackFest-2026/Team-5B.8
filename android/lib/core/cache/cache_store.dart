import 'dart:async';
import 'package:hive/hive.dart';

/// A value together with when it was stored and whether it is still fresh.
/// The UI reads [stale] to decide whether to show a quiet "refreshing" hint
/// over data it is already displaying.
class Cached<T> {
  final T data;
  final DateTime storedAt;
  final bool stale;
  const Cached(this.data, this.storedAt, {this.stale = false});

  Cached<T> asStale() => Cached(data, storedAt, stale: true);
}

/// How long a given key stays fresh before a background revalidation fires.
class CachePolicy {
  final Duration ttl;
  const CachePolicy(this.ttl);

  static const home = CachePolicy(Duration(seconds: 20));
  static const overview = CachePolicy(Duration(seconds: 30));
  static const live = CachePolicy(Duration(seconds: 5));
  static const alerts = CachePolicy(Duration(seconds: 30));
  static const rules = CachePolicy(Duration(minutes: 5));
  static const items = CachePolicy(Duration(minutes: 10));
  static const guardrails = CachePolicy(Duration(minutes: 10));
  static const audit = CachePolicy(Duration(minutes: 2));
}

class _Entry {
  final dynamic json; // decoded JSON (Map or List) as stored
  final int storedAt; // epoch ms
  _Entry(this.json, this.storedAt);
}

/// The multi-level cache that makes the app feel instant.
///
/// Three levels, in order of speed:
///   L1  in-memory map      — instant within a session, zero deserialisation
///   L2  Hive box on disk   — survives restarts, paints the last screen on cold
///                            start before the network has answered
///   L3  the network        — the source of truth, fetched in the background
///
/// On top of those, three behaviours do the real smoothing:
///   • stale-while-revalidate: [watch] yields the cached value immediately, then
///     yields the fresh one when it lands. The screen never shows a blank
///     spinner for data it has seen before.
///   • request coalescing: concurrent reads of the same key share one in-flight
///     network call, so opening three tabs that need `/mobile/home` hits the
///     network once.
///   • a live push channel: the WebSocket layer calls [put]/[patch], and every
///     open [watch] stream for that key receives the update with no refetch.
///
/// The store itself outlives individual screens (it is a singleton held by a
/// keep-alive provider), which is why screen providers can auto-dispose freely
/// and still get an instant value when reopened.
class CacheStore {
  CacheStore(this._box);
  final Box _box;

  final _mem = <String, _Entry>{};
  final _controllers = <String, StreamController<_Entry>>{};
  final _inflight = <String, Future<void>>{};

  StreamController<_Entry> _ctrl(String key) =>
      _controllers.putIfAbsent(key, () => StreamController<_Entry>.broadcast());

  _Entry? _peek(String key) {
    final m = _mem[key];
    if (m != null) return m;
    final raw = _box.get(key);
    if (raw is Map && raw.containsKey('v') && raw.containsKey('t')) {
      final e = _Entry(raw['v'], (raw['t'] as num).toInt());
      _mem[key] = e; // promote disk -> memory
      return e;
    }
    return null;
  }

  bool _isStale(_Entry e, CachePolicy policy) =>
      DateTime.now().millisecondsSinceEpoch - e.storedAt > policy.ttl.inMilliseconds;

  /// Store a fresh value at [key] and notify every open stream. Used by the
  /// fetcher after a network success AND by the live WebSocket layer.
  void put(String key, dynamic json) {
    final e = _Entry(json, DateTime.now().millisecondsSinceEpoch);
    _mem[key] = e;
    // Fire-and-forget disk write; a failed persist must never break the UI.
    unawaited(Future(() => _box.put(key, {'v': json, 't': e.storedAt}))
        .catchError((_) {}));
    if (_controllers[key]?.hasListener ?? false) _controllers[key]!.add(e);
  }

  /// Read the current cached JSON for [key] without touching the network —
  /// used by the live layer to patch a value in place (e.g. prepend a decision).
  dynamic peekJson(String key) => _peek(key)?.json;

  /// Drop a key so the next [watch] is forced to refetch. The in-memory and
  /// disk copies both go; call after a mutation the server now reflects.
  void invalidate(String key) {
    _mem.remove(key);
    unawaited(Future(() => _box.delete(key)).catchError((_) {}));
  }

  void invalidatePrefix(String prefix) {
    _mem.keys.where((k) => k.startsWith(prefix)).toList().forEach(_mem.remove);
    final diskKeys =
        _box.keys.where((k) => k.toString().startsWith(prefix)).toList();
    unawaited(Future(() => _box.deleteAll(diskKeys)).catchError((_) {}));
  }

  /// Fetch from the network (coalesced) and publish the result. [force] skips
  /// the freshness check. Errors propagate to the caller but never corrupt the
  /// cache — a failed revalidation leaves the last good value in place.
  Future<void> _revalidate(
    String key,
    Future<dynamic> Function() fetcher,
  ) {
    final existing = _inflight[key];
    if (existing != null) return existing;
    final f = () async {
      try {
        final json = await fetcher();
        put(key, json);
      } finally {
        _inflight.remove(key);
      }
    }();
    _inflight[key] = f;
    return f;
  }

  /// Stale-while-revalidate read.
  ///
  /// Emits (per listener): the cached value first if there is one, then the
  /// fresh value once the network answers — and thereafter any live push.
  /// If the cached value is still fresh, no network call is made at all.
  Stream<Cached<T>> watch<T>(
    String key, {
    required CachePolicy policy,
    required Future<dynamic> Function() fetcher,
    required T Function(dynamic json) decode,
  }) async* {
    final controller = _ctrl(key);
    final cached = _peek(key);

    if (cached != null) {
      final stale = _isStale(cached, policy);
      yield Cached<T>(
        decode(cached.json),
        DateTime.fromMillisecondsSinceEpoch(cached.storedAt),
        stale: stale,
      );
      if (stale) {
        unawaited(_revalidate(key, fetcher).catchError((_) {
          // Keep showing stale data; the error surfaces only if nothing is cached.
        }));
      }
    } else {
      // Nothing cached: the first real network result is the first emission.
      unawaited(_revalidate(key, fetcher));
    }

    yield* controller.stream.map((e) => Cached<T>(
          decode(e.json),
          DateTime.fromMillisecondsSinceEpoch(e.storedAt),
          stale: false,
        ));
  }

  /// Force a refetch now (pull-to-refresh). Completes when fresh data lands.
  Future<void> refresh(String key, Future<dynamic> Function() fetcher) =>
      _revalidate(key, fetcher);

  Future<void> clearAll() async {
    _mem.clear();
    await _box.clear();
  }
}
