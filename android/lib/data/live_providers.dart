import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../core/live_socket.dart';
import 'providers.dart';

/// Whether this project's WebSocket is currently connected. Drives the small
/// "live" dot on the overview tab.
final liveConnectedProvider =
    StateProvider.autoDispose.family<bool, String>((ref, pid) => false);

/// Owns the project's WebSocket for as long as something watches it. The
/// project shell watches it, so one socket stays up across all tabs and is
/// torn down when you leave the project.
final liveSocketProvider =
    Provider.autoDispose.family<LiveSocket, String>((ref, pid) {
  final store = ref.watch(cacheStoreProvider);
  final f = ref.watch(fetchersProvider);
  final token = ref.watch(authControllerProvider).value?.token ?? '';

  final socket = LiveSocket(
    projectId: pid,
    token: token,
    store: store,
    fetchers: f,
    onStatus: (connected) {
      ref.read(liveConnectedProvider(pid).notifier).state = connected;
    },
  );
  // Connect after build so onStatus doesn't mutate a provider mid-build.
  Future.microtask(socket.connect);
  ref.onDispose(socket.dispose);
  return socket;
});
