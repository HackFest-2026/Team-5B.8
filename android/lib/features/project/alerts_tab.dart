import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';
import '../decisions/decisions_screen.dart';

class AlertsTab extends ConsumerWidget {
  final String projectId;
  const AlertsTab({super.key, required this.projectId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final alerts = ref.watch(alertsProvider(projectId));
    return RefreshIndicator(
      color: AppColors.accent,
      backgroundColor: AppColors.surface,
      onRefresh: () => ref.read(projectActionsProvider).refreshProject(projectId),
      child: CachedView<List<Alert>>(
        value: alerts,
        onRetry: () => ref.read(projectActionsProvider).refreshProject(projectId),
        builder: (context, list, refreshing) {
          final open = list.where((a) => a.isOpen).toList();
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, Gap.x7),
            children: [
              SectionLabel('Alerts · ${open.length} open', trailing: Freshness(
                storedAt: alerts.value?.storedAt, refreshing: refreshing,
              )),
              if (list.isEmpty)
                const SectionCard(
                  padding: EdgeInsets.all(Gap.x6),
                  child: EmptyState(
                    icon: Icons.notifications_off_outlined,
                    title: 'All clear',
                    subtitle: 'No alerts for this project. Critical ones will also push to your phone.',
                  ),
                )
              else
                ...list.map((a) => Padding(
                      padding: const EdgeInsets.only(bottom: Gap.x3),
                      child: _AlertCard(key: ValueKey(a.id), projectId: projectId, alert: a),
                    )),
            ],
          );
        },
      ),
    );
  }
}

class _AlertCard extends ConsumerWidget {
  final String projectId;
  final Alert alert;
  const _AlertCard({super.key, required this.projectId, required this.alert});

  Future<void> _ack(BuildContext context, WidgetRef ref, String action) async {
    try {
      await ref.read(projectActionsProvider).ackAlert(projectId, alert.id, action, alert.ts);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final color = severityColor(alert.severity);
    final t = Theme.of(context).textTheme;
    return SectionCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          StatusDot(color),
          const SizedBox(width: Gap.x2),
          Expanded(
            child: Text(alert.title.isEmpty ? alert.type : alert.title,
                style: t.titleSmall?.copyWith(color: AppColors.text),
                maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          Pill(alert.severity.toUpperCase(), color: color),
        ]),
        if (alert.message.isNotEmpty) ...[
          const SizedBox(height: Gap.x2),
          Text(alert.message, style: t.bodySmall),
        ],
        if (alert.needsDecision) ...[
          const SizedBox(height: Gap.x3),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DecisionsScreen())),
              icon: const Icon(Icons.gavel_rounded, size: 18),
              label: const Text('Make decision'),
              style: FilledButton.styleFrom(minimumSize: const Size(0, 46)),
            ),
          ),
        ],
        const SizedBox(height: Gap.x2),
        Row(children: [
          Text(relativeTime(alert.ts), style: t.labelSmall),
          const Spacer(),
          if (alert.isOpen) ...[
            TextButton(
              onPressed: () => _ack(context, ref, 'dismiss'),
              child: const Text('Dismiss', style: TextStyle(color: AppColors.textMuted)),
            ),
            const SizedBox(width: Gap.x1),
            FilledButton(
              onPressed: () => _ack(context, ref, 'resolve'),
              style: FilledButton.styleFrom(minimumSize: const Size(0, 38)),
              child: const Text('Resolve'),
            ),
          ] else
            Pill(alert.status.toUpperCase(), color: AppColors.textMuted),
        ]),
      ]),
    );
  }
}
