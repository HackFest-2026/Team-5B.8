import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

/// The emergency decision loop: shows the question the backend already wrote
/// and its options, and executes the chosen one via `/approvals/answer`.
/// Fetch one approval by id and open its decision sheet (notification deep-link).
Future<void> showDecisionById(BuildContext context, WidgetRef ref, String approvalId) async {
  try {
    final res = await ref.read(fetchersProvider).approval(approvalId);
    final a = (res['approval'] as Map?) ?? res;
    final decision = PendingDecision.fromJson(a);
    if (decision.options.isEmpty && decision.question.isEmpty) return;
    if (context.mounted) await showDecisionSheet(context, ref, decision);
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not load decision: $e')));
    }
  }
}

Future<void> showDecisionSheet(
    BuildContext context, WidgetRef ref, PendingDecision decision) {
  return showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.surfaceRaised,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.xl)),
    ),
    builder: (_) => _DecisionSheet(decision: decision),
  );
}

class _DecisionSheet extends ConsumerStatefulWidget {
  final PendingDecision decision;
  const _DecisionSheet({required this.decision});
  @override
  ConsumerState<_DecisionSheet> createState() => _DecisionSheetState();
}

class _DecisionSheetState extends ConsumerState<_DecisionSheet> {
  String? _busyOption;

  Future<void> _answer(DecisionOption o) async {
    setState(() => _busyOption = o.id);
    try {
      await ref
          .read(projectActionsProvider)
          .answerDecision(widget.decision.approvalId, o.id);
      if (mounted) {
        Navigator.of(context).pop();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Decision recorded: ${o.label}')),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _busyOption = null);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Could not submit: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.decision;
    final t = Theme.of(context).textTheme;
    final color = severityColor(d.severity);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(Gap.x5, Gap.x4, Gap.x5, Gap.x5),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Center(
            child: Container(
              width: 40, height: 4,
              decoration: BoxDecoration(
                  color: AppColors.borderStrong, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const SizedBox(height: Gap.x5),
          Row(children: [
            StatusDot(color),
            const SizedBox(width: Gap.x2),
            Text('DECISION NEEDED',
                style: t.labelSmall?.copyWith(color: color, letterSpacing: 1.2)),
          ]),
          const SizedBox(height: Gap.x3),
          Text(d.question.isEmpty ? 'A pricing decision needs your approval.' : d.question,
              style: t.titleLarge),
          const SizedBox(height: Gap.x5),
          if (d.options.isEmpty)
            Text('No options were provided. Open the web console to resolve this.',
                style: t.bodySmall)
          else
            ...d.options.map((o) => Padding(
                  padding: const EdgeInsets.only(bottom: Gap.x3),
                  child: _OptionButton(
                    option: o,
                    busy: _busyOption == o.id,
                    disabled: _busyOption != null && _busyOption != o.id,
                    onTap: () => _answer(o),
                  ),
                )),
          const SizedBox(height: Gap.x2),
          TextButton(
            onPressed: _busyOption != null ? null : () => Navigator.of(context).pop(),
            child: const Text('Later', style: TextStyle(color: AppColors.textMuted)),
          ),
        ]),
      ),
    );
  }
}

class _OptionButton extends StatelessWidget {
  final DecisionOption option;
  final bool busy, disabled;
  final VoidCallback onTap;
  const _OptionButton({
    required this.option, required this.busy, required this.disabled, required this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final danger = option.isDanger;
    final color = danger ? AppColors.critical : AppColors.accent;
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
                  Flexible(
                    child: Text(option.label.isEmpty ? option.id : option.label,
                        style: TextStyle(
                            color: disabled ? AppColors.textMuted : color,
                            fontWeight: FontWeight.w700, fontSize: 15)),
                  ),
                  if (option.recommended) ...[
                    const SizedBox(width: Gap.x2),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                          color: AppColors.successMuted, borderRadius: BorderRadius.circular(Radii.pill)),
                      child: const Text('Recommended',
                          style: TextStyle(color: AppColors.successText, fontSize: 10, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ]),
                if (option.consequence.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(option.consequence,
                      style: Theme.of(context).textTheme.bodySmall,
                      maxLines: 3, overflow: TextOverflow.ellipsis),
                ],
              ]),
            ),
            const SizedBox(width: Gap.x3),
            if (busy)
              SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: color))
            else
              Icon(Icons.arrow_forward_rounded, color: disabled ? AppColors.textMuted : color, size: 18),
          ]),
        ),
      ),
    );
  }
}
