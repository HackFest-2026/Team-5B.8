import 'dart:async';
import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import 'env.dart';

/// Handles a push that arrives while the app is terminated/background. Must be a
/// top-level entry point so the engine can call it in its own isolate.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  // The system tray shows the notification itself for background messages; we
  // intentionally do no work here beyond existing, so FCM has a handler to call.
}

/// Wires Firebase Cloud Messaging to the device and the backend:
///  • asks for the Android 13+ notification permission,
///  • shows foreground pushes as local notifications (FCM won't on its own),
///  • registers / refreshes the device token against `/devices/register`.
class PushService {
  PushService(this._ref);
  final Ref _ref;

  final _local = FlutterLocalNotificationsPlugin();
  bool _inited = false;

  // ~4s of strong, repeated buzzes, matched to the 4s custom sound: the phone
  // buzzes and rings for the same window.
  static final Int64List _vibration =
      Int64List.fromList([0, 700, 130, 700, 130, 700, 130, 700, 130, 700]);

  // The 4s custom tone (res/raw/devnexus_alert.mp3). A channel locks its sound
  // at creation, so the id was bumped to v3 to force this one to take effect.
  static const _sound = RawResourceAndroidNotificationSound('devnexus_alert');

  static final AndroidNotificationChannel _channel = AndroidNotificationChannel(
    Env.alertsChannelId,
    'DevNexus alerts',
    description: 'Critical pricing alerts and decisions that need you',
    importance: Importance.max,
    enableVibration: true,
    vibrationPattern: _vibration,
    playSound: true,
    sound: _sound,
  );

  Future<void> init() async {
    if (_inited) return;
    _inited = true;
    try {
      await _local.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        ),
        onDidReceiveNotificationResponse: _onLocalTap,
      );
      await _local
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(_channel);

      await FirebaseMessaging.instance.requestPermission();
      FirebaseMessaging.onMessage.listen(_showForeground);
      FirebaseMessaging.instance.onTokenRefresh.listen((_) => syncToken());
      // Tap handling: background tap, and the tap that cold-launched the app.
      FirebaseMessaging.onMessageOpenedApp.listen((m) => _route(m.data));
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      if (initial != null) _route(initial.data);
    } catch (e) {
      debugPrint('push init failed: $e');
    }
  }

  void _showForeground(RemoteMessage m) {
    final n = m.notification;
    if (n == null) return;
    _local.show(
      id: n.hashCode,
      title: n.title,
      body: n.body,
      payload: jsonEncode(m.data),
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          Env.alertsChannelId,
          'DevNexus alerts',
          importance: Importance.max,
          priority: Priority.max,
          enableVibration: true,
          vibrationPattern: _vibration,
          playSound: true,
          sound: _sound,
        ),
      ),
    );
  }

  void _onLocalTap(NotificationResponse r) {
    if (r.payload == null || r.payload!.isEmpty) return;
    try {
      _route((jsonDecode(r.payload!) as Map).cast<String, dynamic>());
    } catch (_) {}
  }

  /// A notification was tapped: steer the app to that project's decision.
  void _route(Map<String, dynamic> data) {
    final project = (data['project_id'] ?? '').toString();
    final approval = (data['approval_id'] ?? '').toString();
    if (project.isEmpty) return;
    _ref.read(deepLinkProvider.notifier).state = DeepLink(project, approval);
  }

  /// Re-register with a new warning-notifications preference.
  Future<void> setWarnings(bool warnings) async {
    try {
      final f = _ref.read(fetchersProvider);
      if (!f.hasToken) return;
      final fcm = await FirebaseMessaging.instance.getToken();
      if (fcm == null || fcm.isEmpty) return;
      await f.registerDevice(fcm, warnings: warnings);
    } catch (e) {
      debugPrint('set warnings failed: $e');
    }
  }

  /// Push the current FCM token to the backend so this device receives alerts.
  /// Safe to call repeatedly; the server dedupes by a hash of the token.
  Future<void> syncToken() async {
    try {
      final f = _ref.read(fetchersProvider);
      if (!f.hasToken) return;
      final fcm = await FirebaseMessaging.instance.getToken();
      if (fcm == null || fcm.isEmpty) return;
      await f.registerDevice(fcm);
    } catch (e) {
      debugPrint('token sync failed: $e');
    }
  }
}
