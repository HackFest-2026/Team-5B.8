import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});
  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _warnings = true;
  bool _loggingOut = false;

  Future<void> _logout() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Sign out?'),
        content: const Text('You will need your email and password to sign back in.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: AppColors.critical, foregroundColor: AppColors.text,
                minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    setState(() => _loggingOut = true);
    await ref.read(authControllerProvider.notifier).logout();
    // AuthGate returns us to login automatically.
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(authControllerProvider).value;
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(Gap.x4),
        children: [
          SectionCard(
            child: Row(children: [
              CircleAvatar(
                radius: 26,
                backgroundColor: AppColors.accentMuted,
                child: Text(
                  (s?.name.isNotEmpty ?? false)
                      ? s!.name[0].toUpperCase()
                      : (s?.email.isNotEmpty ?? false ? s!.email[0].toUpperCase() : '?'),
                  style: const TextStyle(
                      color: AppColors.accentText, fontWeight: FontWeight.w700, fontSize: 20),
                ),
              ),
              const SizedBox(width: Gap.x4),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s?.name.isNotEmpty ?? false ? s!.name : 'Analyst', style: t.titleMedium),
                  const SizedBox(height: 2),
                  Text(s?.email ?? '', style: t.bodySmall, overflow: TextOverflow.ellipsis),
                ]),
              ),
            ]),
          ),
          const SizedBox(height: Gap.x4),
          const SectionLabel('Account'),
          SectionCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              _Row(label: 'Company', value: s?.companyName ?? '—'),
              const Divider(height: 1),
              _Row(label: 'Currency', value: s?.currency ?? 'INR'),
            ]),
          ),
          const SizedBox(height: Gap.x4),
          const SectionLabel('Notifications'),
          SectionCard(
            child: Row(children: [
              const Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Warning alerts', style: TextStyle(color: AppColors.text, fontWeight: FontWeight.w600)),
                  SizedBox(height: 2),
                  Text('Critical alerts always push. Turn this on to also receive warnings.',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
                ]),
              ),
              Switch(
                value: _warnings,
                onChanged: (v) {
                  setState(() => _warnings = v);
                  ref.read(pushServiceProvider).setWarnings(v);
                },
              ),
            ]),
          ),
          const SizedBox(height: Gap.x6),
          OutlinedButton.icon(
            onPressed: _loggingOut ? null : _logout,
            icon: _loggingOut
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.logout_rounded, size: 18, color: AppColors.criticalText),
            label: const Text('Sign out', style: TextStyle(color: AppColors.criticalText)),
            style: OutlinedButton.styleFrom(
                side: BorderSide(color: AppColors.critical.withValues(alpha: 0.4))),
          ),
          const SizedBox(height: Gap.x5),
          Center(child: Text('DevNexus · companion', style: t.bodySmall)),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final String label, value;
  const _Row({required this.label, required this.value});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x4),
        child: Row(children: [
          Text(label, style: const TextStyle(color: AppColors.textSecondary)),
          const Spacer(),
          Flexible(
            child: Text(value,
                style: const TextStyle(color: AppColors.text, fontWeight: FontWeight.w600),
                overflow: TextOverflow.ellipsis),
          ),
        ]),
      );
}
