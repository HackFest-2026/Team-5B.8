import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';

/// Project-level settings — mirrors the web console: editable guardrails and the
/// approval-to-publish policy — plus a Reset that wipes this project's activity
/// (decisions, analytics, alerts, audit) while keeping products, rules & strategy.
class ProjectSettingsScreen extends ConsumerStatefulWidget {
  final String projectId, projectName;
  const ProjectSettingsScreen({super.key, required this.projectId, required this.projectName});
  @override
  ConsumerState<ProjectSettingsScreen> createState() => _ProjectSettingsScreenState();
}

class _ProjectSettingsScreenState extends ConsumerState<ProjectSettingsScreen> {
  bool _loading = true;
  String? _error;
  Map _project = {};
  bool _requireApproval = false;
  bool _savingGr = false, _resetting = false;

  final _maxInc = TextEditingController();
  final _maxDec = TextEditingController();
  final _minMargin = TextEditingController();

  @override
  void initState() { super.initState(); _load(); }
  @override
  void dispose() {
    for (final c in [_maxInc, _maxDec, _minMargin]) { c.dispose(); }
    super.dispose();
  }

  String _g(Guardrails g, double? v) => v == null ? '' : (v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toString());

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final d = await ref.read(fetchersProvider).projectDetail(widget.projectId);
      final project = (d['project'] as Map?) ?? const {};
      final g = Guardrails.fromJson((d['guardrails'] as Map?) ?? const {});
      _maxInc.text = _g(g, g.maxIncreasePct);
      _maxDec.text = _g(g, g.maxDecreasePct);
      _minMargin.text = _g(g, g.minMarginPct);
      if (mounted) {
        setState(() {
          _project = project;
          _requireApproval = project['require_approval'] == true;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() { _error = '$e'; _loading = false; });
    }
  }

  Future<void> _saveGuardrails() async {
    setState(() => _savingGr = true);
    double? p(TextEditingController c) => c.text.trim().isEmpty ? null : double.tryParse(c.text.trim());
    final g = {
      'max_increase_pct': p(_maxInc), 'max_decrease_pct': p(_maxDec),
      'min_margin_pct': p(_minMargin),
    };
    try {
      await ref.read(projectActionsProvider).saveGuardrails(widget.projectId, g);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Guardrails saved')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not save: $e')));
    } finally {
      if (mounted) setState(() => _savingGr = false);
    }
  }

  Future<void> _toggleApproval(bool v) async {
    setState(() => _requireApproval = v);
    try { await ref.read(projectActionsProvider).setApprovalPolicy(widget.projectId, v); }
    catch (e) {
      if (mounted) {
        setState(() => _requireApproval = !v);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not change policy: $e')));
      }
    }
  }

  Future<void> _reset() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surfaceRaised,
        title: const Text('Reset project data?'),
        content: const Text(
            'This clears all decisions, analytics, alerts and audit for this project. '
            'Products, rules and the strategy are kept. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: AppColors.critical, foregroundColor: AppColors.text, minimumSize: const Size(0, 44)),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Reset'),
          ),
        ],
      ),
    );
    if (yes != true) return;
    setState(() => _resetting = true);
    try {
      await ref.read(projectActionsProvider).resetData(widget.projectId);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Project data reset to a clean slate')));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Reset failed: $e')));
    } finally {
      if (mounted) setState(() => _resetting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Project settings'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(22),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.only(left: Gap.x4, bottom: Gap.x3),
              child: Text(widget.projectName, style: t.bodySmall),
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? ErrorState(message: _error!, onRetry: _load)
              : ListView(
                  padding: const EdgeInsets.all(Gap.x4),
                  children: [
                    // ── info ──
                    SectionCard(
                      padding: EdgeInsets.zero,
                      child: Column(children: [
                        _row('Domain', '${_project['domain_name'] ?? '—'}'),
                        const Divider(height: 1),
                        _row('Items', '${_project['item_count'] ?? 0}'),
                        const Divider(height: 1),
                        _row('Currency', '${_project['currency'] ?? 'INR'}'),
                        const Divider(height: 1),
                        _row('Mode', '${_project['mode'] ?? 'draft'}'.toUpperCase()),
                      ]),
                    ),
                    const SizedBox(height: Gap.x5),
                    // ── guardrails ──
                    const SectionLabel('Safety limits (guardrails)'),
                    SectionCard(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Applied after every rule — a mistake in a rule can never reach a customer. Blank = no limit.',
                            style: t.bodySmall),
                        const SizedBox(height: Gap.x4),
                        Row(children: [
                          Expanded(child: _num('Max increase %', _maxInc)),
                          const SizedBox(width: Gap.x3),
                          Expanded(child: _num('Max decrease %', _maxDec)),
                        ]),
                        const SizedBox(height: Gap.x3),
                        _num('Min margin %', _minMargin),
                        const SizedBox(height: Gap.x4),
                        FilledButton(
                          onPressed: _savingGr ? null : _saveGuardrails,
                          child: _savingGr
                              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.bg))
                              : const Text('Save limits'),
                        ),
                      ]),
                    ),
                    const SizedBox(height: Gap.x5),
                    // ── approval policy ──
                    const SectionLabel('Approval to publish'),
                    SectionCard(
                      child: Row(children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            const Text('Require approval', style: TextStyle(color: AppColors.text, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text(
                                _requireApproval
                                    ? 'Going live waits for an approval first — recorded in the audit trail.'
                                    : 'Changes go live immediately.',
                                style: t.bodySmall),
                          ]),
                        ),
                        Switch(value: _requireApproval, onChanged: _toggleApproval),
                      ]),
                    ),
                    const SizedBox(height: Gap.x6),
                    // ── reset (always available) ──
                    const SectionLabel('Data'),
                    SectionCard(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        const Text('Reset project data', style: TextStyle(color: AppColors.text, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 2),
                        Text('Clears decisions, analytics, alerts and audit. Keeps products, rules and strategy. '
                            'You can do this any time, mid-run or not.', style: t.bodySmall),
                        const SizedBox(height: Gap.x4),
                        OutlinedButton.icon(
                          onPressed: _resetting ? null : _reset,
                          icon: _resetting
                              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                              : const Icon(Icons.restart_alt_rounded, size: 18, color: AppColors.criticalText),
                          label: const Text('Reset data', style: TextStyle(color: AppColors.criticalText)),
                          style: OutlinedButton.styleFrom(
                              minimumSize: const Size.fromHeight(46),
                              side: BorderSide(color: AppColors.critical.withValues(alpha: 0.45))),
                        ),
                      ]),
                    ),
                    const SizedBox(height: Gap.x5),
                  ],
                ),
    );
  }

  Widget _row(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x4),
        child: Row(children: [
          Text(k, style: const TextStyle(color: AppColors.textSecondary)),
          const Spacer(),
          Flexible(child: Text(v, style: const TextStyle(color: AppColors.text, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
        ]),
      );

  Widget _num(String label, TextEditingController c) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: Gap.x2),
          TextField(
            controller: c,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            decoration: const InputDecoration(hintText: '—'),
          ),
        ],
      );
}
