import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

/// One screen, all projects: every pending decision with its options. Answer
/// one → confirmation → back to home. Reachable from a notification tap, the
/// dashboard banner, and a project's alerts.
class DecisionsScreen extends ConsumerStatefulWidget {
  const DecisionsScreen({super.key});
  @override
  ConsumerState<DecisionsScreen> createState() => _DecisionsScreenState();
}

class _DecisionsScreenState extends ConsumerState<DecisionsScreen> {
  bool _loading = true;
  String? _error;
  List<PendingDecision> _decisions = [];
  Map<String, String> _names = {};
  String? _busyApproval;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = _decisions.isEmpty; _error = null; });
    try {
      final f = ref.read(fetchersProvider);
      final res = await f.pendingAll();
      final rows = (res['approvals'] ?? res['pending'] ?? const []) as List;
      final decisions = rows.whereType<Map>().map(PendingDecision.fromJson).toList();
      final names = <String, String>{};
      final home = ref.read(homeProvider).value?.data;
      if (home != null) {
        for (final p in home.projects) { names[p.id] = p.name; }
      }
      if (names.isEmpty) {
        try {
          final me = await ref.read(apiProvider).get('/auth/me',
              token: ref.read(authControllerProvider).value?.token);
          for (final p in (me['projects'] as List? ?? const [])) {
            if (p is Map) names[(p['project_id'] ?? '').toString()] = (p['name'] ?? '').toString();
          }
        } catch (_) {}
      }
      if (mounted) setState(() { _decisions = decisions; _names = names; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _loading = false; });
    }
  }

  Future<void> _answer(PendingDecision d, DecisionOption o) async {
    setState(() => _busyApproval = d.approvalId);
    try {
      await ref.read(projectActionsProvider).answerDecision(d.approvalId, o.id);
      if (!mounted) return;
      await _confirm(o.label);
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
    } catch (e) {
      if (mounted) {
        setState(() => _busyApproval = null);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not submit: $e')));
      }
    }
  }

  Future<void> _confirm(String label) => showDialog<void>(
        context: context,
        builder: (_) => AlertDialog(
          backgroundColor: AppColors.surfaceRaised,
          icon: const Icon(Icons.check_circle_rounded, color: AppColors.successText, size: 40),
          title: const Text('Decision recorded', textAlign: TextAlign.center),
          content: Text('“$label” has been applied. You can change it any time.',
              textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
          actions: [
            Center(
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Done'),
              ),
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Decisions'),
        actions: [
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh_rounded), tooltip: 'Refresh'),
        ],
      ),
      body: RefreshIndicator(
        color: AppColors.accent, backgroundColor: AppColors.surface,
        onRefresh: _load,
        child: _loading
            ? const Center(child: Padding(padding: EdgeInsets.all(Gap.x7), child: CircularProgressIndicator()))
            : _error != null
                ? ErrorState(message: _error!, onRetry: _load)
                : _decisions.isEmpty
                    ? ListView(children: const [
                        SizedBox(height: Gap.x7),
                        EmptyState(
                          icon: Icons.verified_rounded,
                          title: 'No decisions right now',
                          subtitle: 'When pricing needs your call, it shows up here — across every project.'),
                      ])
                    : ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.all(Gap.x4),
                        itemCount: _decisions.length,
                        separatorBuilder: (_, _) => const SizedBox(height: Gap.x4),
                        itemBuilder: (_, i) => _DecisionCard(
                          decision: _decisions[i],
                          projectName: _names[_decisions[i].projectId] ?? 'Project',
                          busy: _busyApproval == _decisions[i].approvalId,
                          disabled: _busyApproval != null,
                          onAnswer: (o) => _answer(_decisions[i], o),
                        ),
                      ),
      ),
    );
  }
}

class _DecisionCard extends StatelessWidget {
  final PendingDecision decision;
  final String projectName;
  final bool busy, disabled;
  final void Function(DecisionOption) onAnswer;
  const _DecisionCard({
    required this.decision, required this.projectName,
    required this.busy, required this.disabled, required this.onAnswer,
  });
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final color = severityColor(decision.severity);
    return SectionCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Pill(projectName, color: AppColors.accent),
          const SizedBox(width: Gap.x2),
          StatusDot(color),
          const SizedBox(width: Gap.x2),
          Text('DECISION NEEDED', style: t.labelSmall?.copyWith(color: color, letterSpacing: 1.1)),
        ]),
        const SizedBox(height: Gap.x3),
        Text(decision.question.isEmpty ? 'A pricing decision needs your approval.' : decision.question,
            style: t.titleMedium?.copyWith(color: AppColors.text)),
        const SizedBox(height: Gap.x4),
        if (decision.options.isEmpty)
          Text('No options provided — open the web console to resolve this.', style: t.bodySmall)
        else
          ...decision.options.map((o) => Padding(
                padding: const EdgeInsets.only(bottom: Gap.x3),
                child: _OptionTile(
                  option: o,
                  busy: busy,
                  disabled: disabled,
                  onTap: () => onAnswer(o),
                ),
              )),
      ]),
    );
  }
}

class _OptionTile extends StatelessWidget {
  final DecisionOption option;
  final bool busy, disabled;
  final VoidCallback onTap;
  const _OptionTile({required this.option, required this.busy, required this.disabled, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final color = option.isDanger ? AppColors.critical : AppColors.accent;
    return Material(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(Radii.md),
      child: InkWell(
        onTap: disabled ? null : onTap,
        borderRadius: BorderRadius.circular(Radii.md),
        child: Container(
          padding: const EdgeInsets.all(Gap.x4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.md),
            border: Border.all(
                color: color.withValues(alpha: option.recommended ? 0.75 : 0.4),
                width: option.recommended ? 1.5 : 1),
          ),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(option.label.isEmpty ? option.id : option.label,
                      style: TextStyle(color: option.isDanger ? AppColors.criticalText : AppColors.accentText,
                          fontWeight: FontWeight.w700, fontSize: 15))),
                  if (option.recommended) ...[
                    const SizedBox(width: Gap.x2),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(color: AppColors.successMuted, borderRadius: BorderRadius.circular(Radii.pill)),
                      child: const Text('Recommended', style: TextStyle(color: AppColors.successText, fontSize: 10, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ]),
                if (option.consequence.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(option.consequence, style: Theme.of(context).textTheme.bodySmall),
                ],
              ]),
            ),
            const SizedBox(width: Gap.x3),
            if (busy)
              SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: color))
            else
              Icon(Icons.arrow_forward_rounded, color: color, size: 18),
          ]),
        ),
      ),
    );
  }
}
