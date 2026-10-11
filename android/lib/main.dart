import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:hive_flutter/hive_flutter.dart';

import 'app.dart';
import 'core/cache/cache_store.dart';
import 'core/push.dart';
import 'data/providers.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Color(0xFF0A0A0B),
    systemNavigationBarIconBrightness: Brightness.light,
  ));

  // Firebase first, so onBackgroundMessage has an app to attach to. On Android
  // the google-services plugin supplies the options, so no DefaultFirebase
  // options file is needed.
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
  } catch (e) {
    debugPrint('Firebase init skipped: $e');
  }

  // The persistent (L2) cache. Opened once here and handed to the store so the
  // first screen can paint from disk before any network call returns.
  await Hive.initFlutter();
  final box = await Hive.openBox('api_cache');

  runApp(
    ProviderScope(
      overrides: [cacheStoreProvider.overrideWithValue(CacheStore(box))],
      child: const DevNexusApp(),
    ),
  );
}
