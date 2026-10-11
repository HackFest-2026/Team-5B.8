import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';
import '../decisions/decisions_screen.dart';
import '../project/project_shell.dart';
import '../settings/settings_screen.dart';

String currencySymbol(String code) {
  switch (code.toUpperCase()) {
    case 'USD': return '\$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'INR': return '₹';
    default: return code.isEmpty ? '₹' : '$code ';
  }
}

/// The general dashboard — one per account. No bottom navigation here: this is
/// the portfolio view. Company name, account-wide analytics, and the projects.
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});
  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  Timer? _poll;
  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 8),
        (_) => ref.read(projectActionsProvider).refreshHome());
  }
  @override
  void dispose() { _poll?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authControllerProvider).value;
    final home = ref.watch(homeProvider);
    final sym = currencySymbol(session?.currency ?? 'INR');

    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          color: AppColors.accent,
          backgroundColor: AppColors.surface,
          onRefresh: () => ref.read(projectActionsProvider).refreshHome(),
          child: CachedView<HomeData>(
            value: home,
            onRetry: () => ref.read(projectActionsProvider).refreshHome(),
            builder: (context, data, refreshing) => CustomScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              slivers: [
                SliverToBoxAdapter(
                  child: _Header(
                    company: (session?.companyName.isNotEmpty ?? false)
                        ? session!.companyName
                        : 'Your company',
                    storedAt: home.value?.storedAt,
                    refreshing: refreshing,
                  ),
                ),
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(Gap.x4, 0, Gap.x4, Gap.x7),
                  sliver: SliverList.list(children: [
                    _StatusStrip(data: data),
                    const SizedBox(height: Gap.x4),
                    if (data.pendingDecision != null) ...[
                      _DecisionBanner(decision: data.pendingDecision!),
                      const SizedBox(height: Gap.x4),
                    ],
                    _Analytics(data: data, sym: sym),
                    const SizedBox(height: Gap.x6),
                    const SectionLabel('Projects'),
                    if (data.projects.isEmpty)
                      const _NoProjects()
                    else
                      ...data.projects.map((p) => Padding(
                            padding: const EdgeInsets.only(bottom: Gap.x3),
                            child: _ProjectCard(project: p),
                          )),
                  ]),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String company;
  final DateTime? storedAt;
  final bool refreshing;
  const _Header({required this.company, this.storedAt, required this.refreshing});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, Gap.x5),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text('DevNexus',
                  style: GoogleFonts.sora(
                      fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
              const SizedBox(width: 2),
              Container(
                margin: const EdgeInsets.only(top: 6),
                width: 4, height: 4,
                decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle),
              ),
            ]),
            const SizedBox(height: 2),
            Text(company,
                style: Theme.of(context).textTheme.headlineSmall,
                maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: Gap.x2),
            Freshness(storedAt: storedAt, refreshing: refreshing),
          ]),
        ),
        _CircleButton(
          icon: Icons.gavel_rounded,
          onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const DecisionsScreen())),
        ),
        const SizedBox(width: Gap.x2),
        _CircleButton(
          icon: Icons.settings_outlined,
          onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const SettingsScreen())),
        ),
      ]),
    );
  }
}

class _CircleButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;
  const _CircleButton({required this.icon, required this.onTap});
  @override
  Widget build(BuildContext context) => Material(
        color: AppColors.surface,
        shape: const CircleBorder(side: BorderSide(color: AppColors.border)),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(Gap.x3),
            child: Icon(icon, size: 20, color: AppColors.textSecondary),
          ),
        ),
      );
}

class _StatusStrip extends StatelessWidget {
  final HomeData data;
  const _StatusStrip({required this.data});
  @override
  Widget build(BuildContext context) {
    final live = data.live;
    final color = live
        ? AppColors.success
        : (data.pausedProjects > 0 ? AppColors.warning : AppColors.textMuted);
    return SectionCard(
      padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x3),
      child: Row(children: [
        StatusDot(color),
        const SizedBox(width: Gap.x3),
        Text(data.statusLabel, style: Theme.of(context).textTheme.titleMedium),
        const Spacer(),
        if (data.openAlerts > 0)
          Pill('${data.openAlerts} alert${data.openAlerts == 1 ? '' : 's'}',
              color: data.criticalAlerts > 0 ? AppColors.critical : AppColors.warning),
      ]),
    );
  }
}

class _Analytics extends StatelessWidget {
  final HomeData data;
  final String sym;
  const _Analytics({required this.data, required this.sym});
  @override
  Widget build(BuildContext context) {
    final tiles = [
      MetricTile(
          label: 'Revenue · 24h',
          value: money(data.revenue24h, symbol: sym),
          icon: Icons.payments_outlined),
      MetricTile(
          label: 'Decisions · 24h',
          value: '${data.decisions24h}',
          icon: Icons.bolt_outlined),
      MetricTile(
          label: 'Price changes',
          value: '${data.priceChanges24h}',
          icon: Icons.swap_vert_rounded),
      MetricTile(
          label: 'Margin · 24h',
          value: money(data.margin24h, symbol: sym),
          icon: Icons.trending_up_rounded),
    ];
    return LayoutBuilder(builder: (context, c) {
      const spacing = Gap.x3;
      final w = (c.maxWidth - spacing) / 2;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: tiles.map((t) => SizedBox(width: w, child: t)).toList(),
      );
    });
  }
}

class _DecisionBanner extends ConsumerWidget {
  final PendingDecision decision;
  const _DecisionBanner({required this.decision});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final color = severityColor(decision.severity);
    return Material(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(Radii.lg),
      child: InkWell(
        borderRadius: BorderRadius.circular(Radii.lg),
        onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DecisionsScreen())),
        child: Container(
          padding: const EdgeInsets.all(Gap.x4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.lg),
            border: Border.all(color: color.withValues(alpha: 0.45)),
          ),
          child: Row(children: [
            Icon(Icons.gavel_rounded, color: color, size: 22),
            const SizedBox(width: Gap.x3),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Decision needed',
                    style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 14)),
                const SizedBox(height: 2),
                Text(
                    decision.question.isEmpty
                        ? 'Tap to review and approve.'
                        : decision.question,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall),
              ]),
            ),
            Icon(Icons.chevron_right_rounded, color: color),
          ]),
        ),
      ),
    );
  }
}

class _ProjectCard extends StatelessWidget {
  final ProjectSummary project;
  const _ProjectCard({required this.project});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final (label, color) = switch (project.mode) {
      'active' => ('LIVE', AppColors.success),
      'paused' => ('PAUSED', AppColors.warning),
      'safe' => ('SAFE MODE', AppColors.warning),
      _ => ('DRAFT', AppColors.textMuted),
    };
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(Radii.lg),
      child: InkWell(
        borderRadius: BorderRadius.circular(Radii.lg),
        onTap: () => Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => ProjectShell(projectId: project.id, projectName: project.name),
        )),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.lg),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: const EdgeInsets.all(Gap.x4),
              child: Row(children: [
                Container(
                  width: 46, height: 46,
                  decoration: BoxDecoration(
                    color: AppColors.accentMuted,
                    borderRadius: BorderRadius.circular(Radii.md),
                  ),
                  child: const Icon(Icons.price_change_rounded, color: AppColors.accentText, size: 23),
                ),
                const SizedBox(width: Gap.x4),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(project.name,
                        style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                        maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 3),
                    Text(
                        project.domainName.isEmpty ? 'Pricing system' : project.domainName,
                        style: t.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                  ]),
                ),
                const SizedBox(width: Gap.x2),
                Pill(label, color: color),
              ]),
            ),
            Container(height: 1, color: AppColors.border),
            Padding(
              padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x3, Gap.x3, Gap.x3),
              child: Row(children: [
                const Icon(Icons.inventory_2_outlined, size: 15, color: AppColors.textMuted),
                const SizedBox(width: Gap.x2),
                Text('${project.itemCount} item${project.itemCount == 1 ? '' : 's'}', style: t.bodySmall),
                const Spacer(),
                const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted, size: 18),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _NoProjects extends StatelessWidget {
  const _NoProjects();
  @override
  Widget build(BuildContext context) => const SectionCard(
        padding: EdgeInsets.all(Gap.x6),
        child: EmptyState(
          icon: Icons.inbox_outlined,
          title: 'No projects yet',
          subtitle: 'Create a pricing system on the DevNexus web console — it will appear here.',
        ),
      );
}
