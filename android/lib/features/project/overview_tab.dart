import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../core/cache/cache_store.dart';
import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';
import '../dashboard/dashboard_screen.dart' show currencySymbol;
import 'products_screen.dart';

const _ranges = ['1h', '6h', '24h', '7d', '30d'];

class OverviewTab extends ConsumerStatefulWidget {
  final String projectId, projectName;
  const OverviewTab({super.key, required this.projectId, required this.projectName});
  @override
  ConsumerState<OverviewTab> createState() => _OverviewTabState();
}

class _OverviewTabState extends ConsumerState<OverviewTab> {
  Timer? _poll;
  String _range = '24h';
  String get _key => '${widget.projectId}|$_range';

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 8),
        (_) => ref.read(projectActionsProvider).refreshOverview(widget.projectId, _range));
  }
  @override
  void dispose() { _poll?.cancel(); super.dispose(); }

  Future<void> _refresh() => Future.wait([
        ref.read(projectActionsProvider).refreshOverview(widget.projectId, _range),
        ref.read(projectActionsProvider).refreshProject(widget.projectId),
      ]);

  @override
  Widget build(BuildContext context) {
    final projectId = widget.projectId;
    final sym = currencySymbol(ref.watch(authControllerProvider).value?.currency ?? 'INR');
    final overview = ref.watch(overviewProvider(_key));
    final latency = ref.watch(systemProvider(projectId));

    return RefreshIndicator(
      color: AppColors.accent,
      backgroundColor: AppColors.surface,
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, Gap.x7),
        children: [
          _RangeBar(value: _range, onChanged: (r) => setState(() => _range = r)),
          const SizedBox(height: Gap.x4),
          _EngineControl(projectId: projectId),
          const SizedBox(height: Gap.x5),
          SectionLabel('Performance · $_range', trailing: Freshness(
            storedAt: overview.value?.storedAt,
            refreshing: overview.isLoading && overview.value != null,
          )),
          CachedView<Overview>(
            value: overview,
            onRetry: _refresh,
            builder: (context, o, _) => _Kpis(o: o, sym: sym),
          ),
          const SizedBox(height: Gap.x3),
          _SpeedCard(value: latency),
          const SizedBox(height: Gap.x5),
          _ProductsButton(projectId: projectId, projectName: widget.projectName),
          const SizedBox(height: Gap.x6),
          const SectionLabel('Live decisions'),
          _LiveDecisions(projectId: projectId, sym: sym),
        ],
      ),
    );
  }
}

/* ── range selector ─────────────────────────────────────── */
class _RangeBar extends StatelessWidget {
  final String value;
  final ValueChanged<String> onChanged;
  const _RangeBar({required this.value, required this.onChanged});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AppColors.surfaceSunken,
        borderRadius: BorderRadius.circular(Radii.pill),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: _ranges.map((r) {
          final on = r == value;
          return Expanded(
            child: GestureDetector(
              onTap: () => onChanged(r),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 180),
                padding: const EdgeInsets.symmetric(vertical: 8),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: on ? AppColors.accent : Colors.transparent,
                  borderRadius: BorderRadius.circular(Radii.pill),
                ),
                child: Text(r,
                    style: GoogleFonts.jetBrainsMono(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: on ? AppColors.bg : AppColors.textSecondary)),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

/* ── animated KPIs ──────────────────────────────────────── */
class _Kpis extends StatelessWidget {
  final Overview o;
  final String sym;
  const _Kpis({required this.o, required this.sym});
  @override
  Widget build(BuildContext context) {
    final tiles = [
      _AnimatedKpi(label: 'Decisions', end: o.decisions.toDouble(), icon: Icons.bolt_outlined,
          fmt: (v) => v.round().toString()),
      _AnimatedKpi(label: 'Price changes', end: o.priceChanges.toDouble(), icon: Icons.swap_vert_rounded,
          fmt: (v) => v.round().toString()),
      _AnimatedKpi(label: 'Average price', end: o.avgPrice, icon: Icons.sell_outlined,
          fmt: (v) => money(v, symbol: sym)),
      _AnimatedKpi(label: 'Guardrail blocks', end: o.guardrailBlocks.toDouble(), icon: Icons.shield_outlined,
          fmt: (v) => v.round().toString()),
    ];
    return LayoutBuilder(builder: (context, c) {
      const spacing = Gap.x3;
      final w = (c.maxWidth - spacing) / 2;
      return Wrap(
        spacing: spacing, runSpacing: spacing,
        children: tiles.map((t) => SizedBox(width: w, child: t)).toList(),
      );
    });
  }
}

class _AnimatedKpi extends StatelessWidget {
  final String label;
  final double end;
  final String Function(double) fmt;
  final IconData icon;
  const _AnimatedKpi({required this.label, required this.end, required this.fmt, required this.icon});
  @override
  Widget build(BuildContext context) {
    return SectionCard(
      padding: const EdgeInsets.all(Gap.x4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 15, color: AppColors.textMuted),
          const SizedBox(width: Gap.x2),
          Expanded(child: Text(label,
              style: Theme.of(context).textTheme.bodySmall, overflow: TextOverflow.ellipsis)),
        ]),
        const SizedBox(height: Gap.x3),
        TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: end),
          duration: const Duration(milliseconds: 650),
          curve: Curves.easeOutCubic,
          builder: (_, v, _) => Text(fmt(v),
              style: GoogleFonts.jetBrainsMono(
                  fontSize: 22, fontWeight: FontWeight.w600, color: AppColors.text),
              maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
      ]),
    );
  }
}

/* ── response time ──────────────────────────────────────── */
class _SpeedCard extends StatelessWidget {
  final AsyncValue<Cached<Latency>> value;
  const _SpeedCard({required this.value});
  @override
  Widget build(BuildContext context) {
    final l = value.value?.data;
    final p50 = l?.p50 ?? 0;
    final p95 = l?.p95 ?? 0;
    final has = (l?.hasData ?? false);
    return SectionCard(
      child: Row(children: [
        Container(
          padding: const EdgeInsets.all(Gap.x3),
          decoration: BoxDecoration(color: AppColors.accentMuted, borderRadius: BorderRadius.circular(Radii.md)),
          child: const Icon(Icons.speed_rounded, color: AppColors.accentText),
        ),
        const SizedBox(width: Gap.x4),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Response time', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 2),
            Text('how fast the pricing API answers', style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          has
              ? TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: p50),
                  duration: const Duration(milliseconds: 600),
                  curve: Curves.easeOutCubic,
                  builder: (_, v, _) => Text('${v.round()} ms',
                      style: GoogleFonts.jetBrainsMono(
                          fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.accentText)),
                )
              : Text('—',
                  style: GoogleFonts.jetBrainsMono(
                      fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.textMuted)),
          const SizedBox(height: 2),
          Text(has ? '${p95.round()} ms slowest 1-in-20' : 'measuring…',
              style: GoogleFonts.jetBrainsMono(fontSize: 11, color: AppColors.textMuted)),
        ]),
      ]),
    );
  }
}

/* ── engine control ─────────────────────────────────────── */
class _EngineControl extends ConsumerWidget {
  final String projectId;
  const _EngineControl({required this.projectId});

  Future<void> _toggle(BuildContext context, WidgetRef ref, ActiveStrategy s, bool live) async {
    try {
      await ref.read(projectActionsProvider).setLive(projectId, s.id, live);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(live ? 'Pricing is now live' : 'Pricing paused')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not change state: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final strat = ref.watch(activeStrategyProvider(projectId));
    return CachedView<ActiveStrategy?>(
      value: strat,
      builder: (context, s, _) {
        final live = s?.isLive ?? false;
        final color = live ? AppColors.success : AppColors.warning;
        return SectionCard(
          child: Row(children: [
            Container(
              padding: const EdgeInsets.all(Gap.x3),
              decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(Radii.md)),
              child: Icon(live ? Icons.bolt_rounded : Icons.pause_rounded, color: color),
            ),
            const SizedBox(width: Gap.x4),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Pricing engine', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(
                  s == null ? 'No active strategy to run'
                      : (live ? 'Serving live prices' : 'Paused — serving safe fallback'),
                  style: Theme.of(context).textTheme.bodySmall),
              ]),
            ),
            if (s != null) Switch(value: live, onChanged: (v) => _toggle(context, ref, s, v)),
          ]),
        );
      },
    );
  }
}

/* ── products button ────────────────────────────────────── */
class _ProductsButton extends StatelessWidget {
  final String projectId, projectName;
  const _ProductsButton({required this.projectId, required this.projectName});
  @override
  Widget build(BuildContext context) => Material(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(Radii.lg),
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.lg),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => ProductsScreen(projectId: projectId, projectName: projectName))),
          child: Container(
            padding: const EdgeInsets.all(Gap.x4),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(Radii.lg), border: Border.all(color: AppColors.border)),
            child: Row(children: [
              const Icon(Icons.inventory_2_outlined, color: AppColors.textSecondary, size: 20),
              const SizedBox(width: Gap.x3),
              Expanded(child: Text('Products', style: Theme.of(context).textTheme.titleMedium)),
              const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
            ]),
          ),
        ),
      );
}

/* ── live decisions (stable height, keyed) ──────────────── */
class _LiveDecisions extends ConsumerWidget {
  final String projectId, sym;
  const _LiveDecisions({required this.projectId, required this.sym});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feed = ref.watch(liveDecisionsProvider(projectId));
    return CachedView<List<LiveDecision>>(
      value: feed,
      builder: (context, decisions, _) {
        if (decisions.isEmpty) {
          return const SectionCard(
            padding: EdgeInsets.all(Gap.x6),
            child: EmptyState(
              icon: Icons.graphic_eq_rounded,
              title: 'Waiting for traffic',
              subtitle: 'Pricing decisions stream in here the moment your API is called.'),
          );
        }
        final shown = decisions.length > 8 ? decisions.sublist(0, 8) : decisions;
        return SectionCard(
          padding: EdgeInsets.zero,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < shown.length; i++) ...[
              if (i > 0) const Divider(height: 1),
              _DecisionRow(key: ValueKey(shown[i].id), d: shown[i], sym: sym),
            ],
          ]),
        );
      },
    );
  }
}

class _DecisionRow extends StatelessWidget {
  final LiveDecision d;
  final String sym;
  const _DecisionRow({super.key, required this.d, required this.sym});
  @override
  Widget build(BuildContext context) {
    final up = d.changePct >= 0;
    final color = !d.changed ? AppColors.textMuted : (up ? AppColors.success : AppColors.critical);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x3),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(d.itemId.isEmpty ? 'item' : d.itemId,
                style: GoogleFonts.jetBrainsMono(fontSize: 13, color: AppColors.text),
                maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 2),
            Text(d.rulesFired.isEmpty ? 'no rules fired' : d.rulesFired.join(' · '),
                style: Theme.of(context).textTheme.bodySmall,
                maxLines: 1, overflow: TextOverflow.ellipsis),
          ]),
        ),
        const SizedBox(width: Gap.x3),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text(money(d.price, symbol: sym),
              style: GoogleFonts.jetBrainsMono(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.text)),
          const SizedBox(height: 2),
          Text(d.changed ? '${up ? '+' : ''}${d.changePct.toStringAsFixed(1)}%' : 'no change',
              style: GoogleFonts.jetBrainsMono(fontSize: 11, color: color)),
        ]),
      ]),
    );
  }
}
