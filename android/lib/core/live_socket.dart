import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../data/models.dart';
import '../data/repository.dart';
import 'cache/cache_store.dart';
import 'env.dart';

/// The realtime layer. One socket per open project, subscribed to the
/// `decisions`, `alerts` and `kpis` channels. Incoming frames do not trigger a
/// refetch — they update the cache in place, so every screen watching that key
/// repaints instantly from a push. A `truncated` frame (payload too big for a
/// WS frame) is the one case that asks the cache to revalidate over REST.
///
/// Reconnects with capped exponential backoff; the cached data stays on screen
/// the whole time a reconnect is in flight, so a dropped socket is invisible.
class LiveSocket {
  LiveSocket({
    required this.projectId,
    required this.token,
    required this.store,
    required this.fetchers,
    this.onStatus,
  });

  final String projectId, token;
  final CacheStore store;
  final Fetchers fetchers;
  final void Function(bool connected)? onStatus;

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _retry;
  int _attempt = 0;
  bool _disposed = false;

  void connect() {
    if (_disposed) return;
    final url = '${Env.wsBase}'
        '?token=${Uri.encodeQueryComponent(token)}'
        '&project_id=${Uri.encodeQueryComponent(projectId)}'
        '&channels=decisions,alerts,kpis';
    try {
      final ch = WebSocketChannel.connect(Uri.parse(url));
      _ch = ch;
      _sub = ch.stream.listen(_onFrame, onDone: _scheduleRetry, onError: (_) => _scheduleRetry());
      // Narrow the subscription explicitly once open (connect-time channels is
      // enough, but this also re-asserts after a server-side reset).
      ch.sink.add(jsonEncode({'action': 'subscribe', 'channels': ['decisions', 'alerts', 'kpis']}));
      _attempt = 0;
      onStatus?.call(true);
    } catch (e) {
      debugPrint('ws connect failed: $e');
      _scheduleRetry();
    }
  }

  void _onFrame(dynamic raw) {
    Map? frame;
    try {
      frame = jsonDecode(raw as String) as Map;
    } catch (_) {
      return;
    }
    if (frame['truncated'] == true) {
      // Payload was too large to stream; pull the authoritative state.
      unawaited(store.refresh(CacheKeys.alerts(projectId), () => fetchers.alerts(projectId)));
      return;
    }
    final channel = frame['channel'];
    final data = frame['data'];
    final ts = (frame['ts'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    if (data is! Map) return;

    switch (channel) {
      case 'decisions':
        _prependDecision(LiveDecision.fromJson(data, ts: ts));
        break;
      case 'alerts':
        // Alert frames differ in shape from /alerts/list, so revalidate the
        // list rather than splice — correctness over a saved round trip.
        unawaited(store.refresh(CacheKeys.alerts(projectId), () => fetchers.alerts(projectId)));
        break;
      case 'kpis':
        unawaited(store.refresh(CacheKeys.overview(projectId), () => fetchers.overview(projectId)));
        break;
    }
  }

  void _prependDecision(LiveDecision d) {
    final key = CacheKeys.liveDecisions(projectId);
    final existing = (store.peekJson(key) as List?)?.cast<dynamic>() ?? <dynamic>[];
    final updated = [d.toJson(), ...existing].take(50).toList();
    store.put(key, updated);
  }

  void _scheduleRetry() {
    onStatus?.call(false);
    _sub?.cancel();
    _ch = null;
    if (_disposed) return;
    final delayMs = (500 * (1 << _attempt)).clamp(500, 15000);
    _attempt = (_attempt + 1).clamp(0, 5);
    _retry?.cancel();
    _retry = Timer(Duration(milliseconds: delayMs), connect);
  }

  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _sub?.cancel();
    _ch?.sink.close();
  }
}
