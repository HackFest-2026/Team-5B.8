import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import 'rule_editor_sheet.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

/// Rules and guardrails on one screen (the user's explicit layout). Guardrails
/// are the band the price can never cross; rules move it inside that band. You
/// can switch rules on/off here — guardrails are read-only in the app.
class RulesGuardsTab extends ConsumerWidget {
  final String projectId;
  const RulesGuardsTab({super.key, required this.projectId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rg = ref.watch(rulesGuardsProvider(projectId));
    return Scaffold(
      backgroundColor: Colors.transparent,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final ok = await showRuleEditor(context, projectId);
          if (ok == true && context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Rule created')));
          }
        },
        backgroundColor: AppColors.accent,
        foregroundColor: AppColors.bg,
        icon: const Icon(Icons.add_rounded),
        label: const Text('New rule'),
      ),
      body: RefreshIndicator(
      color: AppColors.accent,
      backgroundColor: AppColors.surface,
      onRefresh: () => ref.read(projectActionsProvider).refreshProject(projectId),
      child: CachedView<RulesAndGuards>(
        value: rg,
        onRetry: () => ref.read(projectActionsProvider).refreshProject(projectId),
        builder: (context, data, refreshing) => ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, 96),
          children: [
            const _SectionHeading(
              icon: Icons.verified_user_rounded,
              title: 'Guardrails',
              subtitle: 'The safety band — the price can never cross these limits.',
            ),
            _Guardrails(g: data.guardrails),
            const SizedBox(height: Gap.x6),
            _SectionHeading(
              icon: Icons.tune_rounded,
              title: 'Rules',
              subtitle:
                  '${data.rules.where((r) => r.enabled).length} of ${data.rules.length} live · they move the price inside the band.',
            ),
            if (data.rules.isEmpty)
              const SectionCard(
                padding: EdgeInsets.all(Gap.x6),
                child: EmptyState(
                  icon: Icons.tune_rounded,
                  title: 'No rules yet',
                  subtitle: 'Tap “New rule” to create your first one.',
                ),
              )
            else
              ...data.rules.map((r) => Padding(
                    padding: const EdgeInsets.only(bottom: Gap.x3),
                    child: _RuleCard(projectId: projectId, rule: r),
                  )),
          ],
        ),
      ),
    ));
  }
}

class _Guardrails extends StatelessWidget {
  final Guardrails g;
  const _Guardrails({required this.g});
  @override
  Widget build(BuildContext context) {
    if (g.isEmpty) {
      return const SectionCard(
        child: Row(children: [
          Icon(Icons.shield_outlined, color: AppColors.textMuted, size: 20),
          SizedBox(width: Gap.x3),
          Expanded(child: Text('No guardrails set — rules run unbounded.',
              style: TextStyle(color: AppColors.textSecondary))),
        ]),
      );
    }
    final rows = <(String, String)>[
      if (g.maxIncreasePct != null) ('Max increase', '+${g.maxIncreasePct!.toStringAsFixed(0)}%'),
      if (g.maxDecreasePct != null) ('Max decrease', '-${g.maxDecreasePct!.toStringAsFixed(0)}%'),
      if (g.minPrice != null) ('Floor price', g.minPrice!.toStringAsFixed(2)),
      if (g.maxPrice != null) ('Ceiling price', g.maxPrice!.toStringAsFixed(2)),
      if (g.minMarginPct != null) ('Min margin', '${g.minMarginPct!.toStringAsFixed(0)}%'),
    ];
    return SectionCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: const [
          Icon(Icons.shield_outlined, color: AppColors.accentText, size: 20),
          SizedBox(width: Gap.x2),
          Text('The price stays inside this band',
              style: TextStyle(color: AppColors.text, fontWeight: FontWeight.w600)),
        ]),
        const SizedBox(height: Gap.x4),
        Wrap(
          spacing: Gap.x2, runSpacing: Gap.x2,
          children: rows
              .map((r) => Container(
                    padding: const EdgeInsets.symmetric(horizontal: Gap.x3, vertical: Gap.x2),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceSunken,
                      borderRadius: BorderRadius.circular(Radii.md),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text('${r.$1}  ', style: Theme.of(context).textTheme.bodySmall),
                      Text(r.$2,
                          style: GoogleFonts.jetBrainsMono(
                              color: AppColors.accentText, fontWeight: FontWeight.w600, fontSize: 13)),
                    ]),
                  ))
              .toList(),
        ),
      ]),
    );
  }
}

class _RuleCard extends ConsumerStatefulWidget {
  final String projectId;
  final Rule rule;
  const _RuleCard({required this.projectId, required this.rule});
  @override
  ConsumerState<_RuleCard> createState() => _RuleCardState();
}

class _RuleCardState extends ConsumerState<_RuleCard> {
  bool _busy = false;

  Future<void> _toggle(bool v) async {
    setState(() => _busy = true);
    try {
      await ref.read(projectActionsProvider).toggleRule(widget.projectId, widget.rule.id, v);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not update rule: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _menu(BuildContext context) => PopupMenuButton<String>(
        icon: const Icon(Icons.more_vert_rounded, color: AppColors.textMuted, size: 20),
        color: AppColors.surfaceRaised,
        onSelected: (v) async {
          if (v == 'edit') {
            final ok = await showRuleEditor(context, widget.projectId, existing: widget.rule);
            if (ok == true && context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Rule updated')));
            }
          } else if (v == 'delete') {
            await _confirmDelete(context);
          }
        },
        itemBuilder: (_) => const [
          PopupMenuItem(value: 'edit', child: Text('Edit')),
          PopupMenuItem(value: 'delete', child: Text('Delete', style: TextStyle(color: AppColors.criticalText))),
        ],
      );

  Future<void> _confirmDelete(BuildContext context) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Delete rule?'),
        content: Text('"${widget.rule.name}" will be removed from the live strategy.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: AppColors.critical, foregroundColor: AppColors.text,
                minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    try {
      await ref.read(projectActionsProvider).deleteRule(widget.projectId, widget.rule.id);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Rule deleted')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Delete failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.rule;
    final t = Theme.of(context).textTheme;
    final adj = r.adjustment;
    final detail = r.explanation.isNotEmpty ? r.explanation : r.description;
    final up = adj?.isIncrease ?? true;
    final outColor =
        adj == null ? AppColors.textMuted : (up ? AppColors.successText : AppColors.warningText);

    return Opacity(
      opacity: r.enabled ? 1 : 0.62,
      child: SectionCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // ── header: name · status · toggle ──
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(r.name, style: t.titleMedium?.copyWith(color: AppColors.text)),
                const SizedBox(height: 4),
                Row(children: [
                  Container(width: 7, height: 7, decoration: BoxDecoration(
                      color: r.enabled ? AppColors.success : AppColors.textMuted, shape: BoxShape.circle)),
                  const SizedBox(width: 6),
                  Text(r.enabled ? 'Live' : 'Off', style: t.labelSmall),
                  Text('   ·   fired ${r.triggerCount}×', style: t.labelSmall),
                ]),
              ]),
            ),
            const SizedBox(width: Gap.x2),
            if (_busy)
              const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
            else
              Switch(value: r.enabled, onChanged: _toggle),
            _menu(context),
          ]),

          // ── plain-English summary ──
          if (detail.isNotEmpty) ...[
            const SizedBox(height: Gap.x3),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(Gap.x3),
              decoration: BoxDecoration(
                  color: AppColors.surfaceSunken, borderRadius: BorderRadius.circular(Radii.md)),
              child: Text(detail, style: t.bodyMedium?.copyWith(color: AppColors.text, height: 1.45)),
            ),
          ],

          // ── IF (worded conditions) ──
          if (r.clauses.isNotEmpty) ...[
            const SizedBox(height: Gap.x4),
            _label('IF'),
            const SizedBox(height: Gap.x2),
            for (var i = 0; i < r.clauses.length; i++) ...[
              if (i > 0)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Text(r.logic == 'any' ? 'or' : 'and',
                      style: t.labelSmall?.copyWith(color: AppColors.accentText, fontWeight: FontWeight.w700)),
                ),
              _conditionRow(context, r.clauses[i]),
            ],
          ],

          // ── THEN (outcome pill) ──
          if (adj != null) ...[
            const SizedBox(height: Gap.x4),
            _label('THEN'),
            const SizedBox(height: Gap.x2),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x3),
              decoration: BoxDecoration(
                color: up ? AppColors.successMuted : AppColors.warningMuted,
                borderRadius: BorderRadius.circular(Radii.md),
                border: Border.all(color: outColor.withValues(alpha: 0.4)),
              ),
              child: Row(children: [
                Icon(up ? Icons.trending_up_rounded : Icons.trending_down_rounded, color: outColor, size: 20),
                const SizedBox(width: Gap.x3),
                Expanded(
                  child: Text(up ? 'Price goes up' : 'Price comes down',
                      style: t.titleSmall?.copyWith(color: AppColors.text)),
                ),
                Text(_adjText(adj),
                    style: GoogleFonts.jetBrainsMono(fontSize: 18, fontWeight: FontWeight.w800, color: outColor)),
              ]),
            ),
          ],

          // ── footer tags ──
          const SizedBox(height: Gap.x3),
          Wrap(spacing: Gap.x2, runSpacing: Gap.x2, children: [
            _tag(context, 'Priority ${r.priority}'),
            _tag(context, r.stackable ? 'Stacks with others' : 'Exclusive'),
            if (r.conflictGroup.isNotEmpty) _tag(context, 'Group: ${r.conflictGroup}'),
          ]),
        ]),
      ),
    );
  }

  Widget _label(String s) => Text(s,
      style: GoogleFonts.jetBrainsMono(
          fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 1.5, color: AppColors.textMuted));

  Widget _conditionRow(BuildContext context, RuleClause c) => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            margin: const EdgeInsets.only(top: 7, right: Gap.x3),
            width: 5, height: 5,
            decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle)),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppColors.text, height: 1.4),
                children: [
                  TextSpan(text: '${_fieldLabel(c.field)} '),
                  TextSpan(text: '${_opWord(c.operator)} ',
                      style: const TextStyle(color: AppColors.textSecondary)),
                  TextSpan(text: _condValue(c),
                      style: GoogleFonts.jetBrainsMono(fontWeight: FontWeight.w700, color: AppColors.accentText)),
                ],
              ),
            ),
          ),
        ]),
      );

  Widget _tag(BuildContext context, String s) => Container(
        padding: const EdgeInsets.symmetric(horizontal: Gap.x3, vertical: 4),
        decoration: BoxDecoration(
            color: AppColors.surfaceSunken, borderRadius: BorderRadius.circular(Radii.pill),
            border: Border.all(color: AppColors.border)),
        child: Text(s, style: Theme.of(context).textTheme.labelSmall),
      );
}

String _fieldLabel(String id) {
  if (id.isEmpty) return id;
  final s = id.replaceAll('_', ' ');
  return s[0].toUpperCase() + s.substring(1);
}

String _opWord(String op) => const {
      '>=': 'is at least', '<=': 'is at most', '>': 'is above', '<': 'is below',
      '==': 'is', '!=': 'is not', 'between': 'is between', 'in': 'is one of',
      'not_in': 'is not one of',
    }[op] ?? op;

String _valStr(dynamic v) {
  if (v is bool) return v ? 'yes' : 'no';
  if (v is num) return v == v.roundToDouble() ? v.toInt().toString() : v.toString();
  return v?.toString() ?? '';
}

String _condValue(RuleClause c) {
  if (c.operator == 'between' && c.value2 != null) {
    return '${_valStr(c.value)} and ${_valStr(c.value2)}';
  }
  return _valStr(c.value);
}

String _adjText(RuleAdjustment a) {
  final pct = a.type == 'percentage';
  final n = a.value == a.value.roundToDouble() ? a.value.toStringAsFixed(0) : a.value.toStringAsFixed(1);
  return (a.isIncrease ? '+' : '−') + n + (pct ? '%' : '');
}

class _SectionHeading extends StatelessWidget {
  final IconData icon;
  final String title, subtitle;
  const _SectionHeading({required this.icon, required this.title, required this.subtitle});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: Gap.x3),
        child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Container(
            padding: const EdgeInsets.all(Gap.x2),
            decoration: BoxDecoration(
                color: AppColors.accentMuted, borderRadius: BorderRadius.circular(Radii.sm)),
            child: Icon(icon, size: 18, color: AppColors.accentText),
          ),
          const SizedBox(width: Gap.x3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      color: AppColors.text, fontWeight: FontWeight.w700)),
              const SizedBox(height: 1),
              Text(subtitle,
                  style: Theme.of(context).textTheme.bodySmall,
                  maxLines: 2, overflow: TextOverflow.ellipsis),
            ]),
          ),
        ]),
      );
}
