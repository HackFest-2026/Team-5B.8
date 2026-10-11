import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import 'data/providers.dart';
import 'features/dashboard/dashboard_screen.dart';
import 'features/decisions/decisions_screen.dart';
import 'features/login/login_screen.dart';
import 'theme/theme.dart';

class DevNexusApp extends ConsumerStatefulWidget {
  const DevNexusApp({super.key});
  @override
  ConsumerState<DevNexusApp> createState() => _DevNexusAppState();
}

class _DevNexusAppState extends ConsumerState<DevNexusApp> {
  final _navKey = GlobalKey<NavigatorState>();

  void _handleDeepLink(DeepLink dl) {
    // Clear it so it fires once.
    Future.microtask(() {
      if (mounted) ref.read(deepLinkProvider.notifier).state = null;
    });
    if (ref.read(authControllerProvider).value == null) return; // not logged in
    _navKey.currentState?.push(
      MaterialPageRoute(builder: (_) => const DecisionsScreen()),
    );
  }

  @override
  void initState() {
    super.initState();
    // Set up notification channels + listeners once, after the first frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(pushServiceProvider).init();
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<DeepLink?>(deepLinkProvider, (_, next) {
      if (next != null) _handleDeepLink(next);
    });
    return MaterialApp(
      title: 'DevNexus',
      navigatorKey: _navKey,
      debugShowCheckedModeBanner: false,
      theme: buildDarkTheme(),
      darkTheme: buildDarkTheme(),
      themeMode: ThemeMode.dark,
      home: const _AuthGate(),
    );
  }
}

/// Decides between login and the dashboard. A splash shows only on the very
/// first load (restoring a stored session); during an actual login attempt the
/// login screen stays put with its own spinner.
class _AuthGate extends ConsumerWidget {
  const _AuthGate();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    if (auth.isLoading && !auth.hasValue) return const _Splash();
    final session = auth.value;
    return session == null ? const LoginScreen() : const DashboardScreen();
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text('DevNexus',
                  style: GoogleFonts.sora(
                      fontSize: 24, fontWeight: FontWeight.w700, color: AppColors.text)),
              const SizedBox(width: 3),
              Container(
                margin: const EdgeInsets.only(top: 11),
                width: 7, height: 7,
                decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle),
              ),
            ]),
            const SizedBox(height: Gap.x5),
            const SizedBox(
              width: 22, height: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ]),
        ),
      );
}
