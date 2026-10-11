import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

class AuditTab extends ConsumerWidget {
  final String projectId;
  const AuditTab({super.key, required this.projectId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final audit = ref.watch(auditProvider(projectId));
    return RefreshIndicator(
      color: AppColors.accent,
      backgroundColor: AppColors.surface,
      onRefresh: () => ref.read(projectActionsProvider).refreshProject(projectId),
      child: CachedView<List<AuditEntry>>(
        value: audit,
        onRetry: () => ref.read(projectActionsProvider).refreshProject(projectId),
        builder: (context, list, refreshing) => ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, Gap.x7),
          children: [
            SectionLabel('Audit trail', trailing: Freshness(
              storedAt: audit.value?.storedAt, refreshing: refreshing,
            )),
            if (list.isEmpty)
              const SectionCard(
                padding: EdgeInsets.all(Gap.x6),
                child: EmptyState(
                  icon: Icons.history_rounded,
                  title: 'Nothing logged yet',
                  subtitle: 'Every change — who, what, when — is recorded here.',
                ),
              )
            else
              SectionCard(
                padding: EdgeInsets.zero,
                child: Column(children: [
                  for (var i = 0; i < list.length; i++) ...[
                    if (i > 0) const Divider(height: 1),
                    _AuditRow(key: ValueKey('${list[i].ts}-${list[i].entityId}-$i'), e: list[i]),
                  ],
                ]),
              ),
          ],
        ),
      ),
    );
  }
}

class _AuditRow extends StatelessWidget {
  final AuditEntry e;
  const _AuditRow({super.key, required this.e});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          margin: const EdgeInsets.only(top: 5),
          width: 6, height: 6,
          decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle),
        ),
        const SizedBox(width: Gap.x3),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(e.action.replaceAll('_', ' '),
                style: GoogleFonts.jetBrainsMono(
                    fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.text)),
            const SizedBox(height: 2),
            Text(
                [
                  if (e.entityType.isNotEmpty) e.entityType,
                  if (e.entityId.isNotEmpty) e.entityId,
                  if (e.actor.isNotEmpty) 'by ${e.actor}',
                ].join(' · '),
                style: t.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
          ]),
        ),
        const SizedBox(width: Gap.x2),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(relativeTime(e.ts), style: t.labelSmall),
          if (e.source.isNotEmpty) ...[
            const SizedBox(height: 2),
            Pill(e.source.toUpperCase(),
                color: e.source == 'android' ? AppColors.accent : AppColors.textMuted),
          ],
        ]),
      ]),
    );
  }
}
