import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/models.dart';
import '../../data/providers.dart';
import '../../theme/theme.dart';

/// Guided, single-condition rule builder (create or edit).
Future<bool?> showRuleEditor(BuildContext context, String projectId, {Rule? existing}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.surfaceRaised,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.xl))),
    builder: (_) => _RuleEditor(projectId: projectId, existing: existing),
  );
}

const _numOps = {
  '>=': 'is at least', '<=': 'is at most', '>': 'is above', '<': 'is below',
  '==': 'is exactly', '!=': 'is not',
};
const _catOps = {'==': 'is', '!=': 'is not'};

class _RuleEditor extends ConsumerStatefulWidget {
  final String projectId;
  final Rule? existing;
  const _RuleEditor({required this.projectId, this.existing});
  @override
  ConsumerState<_RuleEditor> createState() => _RuleEditorState();
}

class _RuleEditorState extends ConsumerState<_RuleEditor> {
  final _name = TextEditingController();
  final _value = TextEditingController();
  final _amount = TextEditingController(text: '5');
  final _priority = TextEditingController(text: '50');
  String? _signalId;
  String _op = '>=';
  String _enumValue = '';
  bool _boolValue = true;
  String _direction = 'increase';
  String _adjType = 'percentage';
  bool _busy = false;
  String? _error;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    if (e != null) {
      _name.text = e.name;
      _priority.text = e.priority.toString();
      if (e.clauses.isNotEmpty) {
        final c = e.clauses.first;
        _signalId = c.field;
        _op = c.operator;
        if (c.value is bool) {
          _boolValue = c.value == true;
        } else if (c.value is num) {
          _value.text = (c.value as num).toString();
        } else {
          _enumValue = c.value?.toString() ?? '';
          _value.text = _enumValue;
        }
      }
      final a = e.adjustment;
      if (a != null) {
        _direction = a.direction.isEmpty ? 'increase' : a.direction;
        _adjType = a.type.isEmpty ? 'percentage' : a.type;
        _amount.text = a.value == a.value.roundToDouble()
            ? a.value.toStringAsFixed(0) : a.value.toString();
      }
    }
  }

  @override
  void dispose() {
    for (final c in [_name, _value, _amount, _priority]) {
      c.dispose();
    }
    super.dispose();
  }

  Signal? _signal(List<Signal> all) {
    for (final s in all) {
      if (s.id == _signalId) return s;
    }
    return null;
  }

  Future<void> _save(List<Signal> signals) async {
    final sig = _signal(signals);
    if (_name.text.trim().isEmpty) { setState(() => _error = 'Give the rule a name'); return; }
    if (sig == null) { setState(() => _error = 'Pick a signal'); return; }

    dynamic value;
    if (sig.isBool) {
      value = _boolValue;
    } else if (sig.isEnum) {
      if (_enumValue.isEmpty) { setState(() => _error = 'Pick a value'); return; }
      value = _enumValue;
    } else {
      final v = double.tryParse(_value.text.trim());
      if (v == null) { setState(() => _error = 'Enter a number for the value'); return; }
      value = v;
    }
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0) { setState(() => _error = 'Enter a positive amount'); return; }
    final priority = int.tryParse(_priority.text.trim()) ?? 50;

    final conditions = [{'field': sig.id, 'operator': _op, 'value': value}];
    final adjustment = {'type': _adjType, 'value': amount, 'direction': _direction};

    setState(() { _busy = true; _error = null; });
    try {
      final actions = ref.read(projectActionsProvider);
      if (_isEdit) {
        await actions.updateRule(widget.projectId, widget.existing!.id,
            name: _name.text.trim(), conditions: conditions, adjustment: adjustment, priority: priority);
      } else {
        await actions.createRule(widget.projectId,
            name: _name.text.trim(), conditions: conditions, adjustment: adjustment, priority: priority);
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() { _busy = false; _error = '$e'; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final signalsAsync = ref.watch(schemaSignalsProvider(widget.projectId));
    final signals = signalsAsync.value?.data ?? const <Signal>[];
    final sig = _signal(signals);
    final t = Theme.of(context).textTheme;
    final ops = (sig?.isNumber ?? true) ? _numOps : _catOps;
    if (!ops.containsKey(_op)) _op = ops.keys.first;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(Gap.x5, Gap.x4, Gap.x5, Gap.x5),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Center(
              child: Container(width: 40, height: 4, decoration: BoxDecoration(
                  color: AppColors.borderStrong, borderRadius: BorderRadius.circular(2))),
            ),
            const SizedBox(height: Gap.x4),
            Text(_isEdit ? 'Edit rule' : 'New rule', style: t.headlineSmall),
            const SizedBox(height: Gap.x5),

            _lbl('Rule name'),
            TextField(controller: _name, decoration: const InputDecoration(hintText: 'e.g. Weekend surcharge')),
            const SizedBox(height: Gap.x5),

            _lbl('WHEN'),
            if (signalsAsync.isLoading && signals.isEmpty)
              const Padding(padding: EdgeInsets.all(Gap.x3), child: Text('Loading signals…'))
            else if (signals.isEmpty)
              Text('This project has no signals to build a rule on.', style: t.bodySmall)
            else
              DropdownButtonFormField<String>(
                initialValue: _signalId,
                isExpanded: true,
                decoration: const InputDecoration(hintText: 'Choose a signal'),
                dropdownColor: AppColors.surfaceRaised,
                items: signals.map((s) => DropdownMenuItem(
                    value: s.id, child: Text(s.label, overflow: TextOverflow.ellipsis))).toList(),
                onChanged: (v) => setState(() { _signalId = v; _enumValue = ''; _value.clear(); }),
              ),
            const SizedBox(height: Gap.x3),
            Row(children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: ops.containsKey(_op) ? _op : ops.keys.first,
                  isExpanded: true,
                  decoration: const InputDecoration(),
                  dropdownColor: AppColors.surfaceRaised,
                  items: ops.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))).toList(),
                  onChanged: (v) => setState(() => _op = v ?? _op),
                ),
              ),
              const SizedBox(width: Gap.x3),
              Expanded(child: _valueField(sig)),
            ]),
            const SizedBox(height: Gap.x5),

            _lbl('THEN'),
            _segmented(
              value: _direction,
              options: const {'increase': 'Price goes up', 'decrease': 'Price comes down'},
              onChanged: (v) => setState(() => _direction = v),
            ),
            const SizedBox(height: Gap.x3),
            Row(children: [
              Expanded(
                child: _segmented(
                  value: _adjType,
                  options: const {'percentage': 'Percent %', 'absolute': 'Points'},
                  onChanged: (v) => setState(() => _adjType = v),
                ),
              ),
              const SizedBox(width: Gap.x3),
              SizedBox(
                width: 110,
                child: TextField(
                  controller: _amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                  decoration: InputDecoration(suffixText: _adjType == 'percentage' ? '%' : 'pts'),
                ),
              ),
            ]),
            const SizedBox(height: Gap.x5),

            _lbl('Priority (higher wins ties)'),
            SizedBox(
              width: 120,
              child: TextField(
                controller: _priority,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(hintText: '50'),
              ),
            ),

            if (_error != null) ...[
              const SizedBox(height: Gap.x4),
              Text(_error!, style: const TextStyle(color: AppColors.criticalText, fontSize: 13)),
            ],
            const SizedBox(height: Gap.x6),
            FilledButton(
              onPressed: _busy ? null : () => _save(signals),
              child: _busy
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.bg))
                  : Text(_isEdit ? 'Save changes' : 'Create rule'),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _valueField(Signal? sig) {
    if (sig != null && sig.isBool) {
      return _segmented(
        value: _boolValue ? 'true' : 'false',
        options: const {'true': 'Yes', 'false': 'No'},
        onChanged: (v) => setState(() => _boolValue = v == 'true'),
      );
    }
    if (sig != null && sig.isEnum) {
      return DropdownButtonFormField<String>(
        initialValue: _enumValue.isEmpty ? null : _enumValue,
        isExpanded: true,
        decoration: const InputDecoration(hintText: 'value'),
        dropdownColor: AppColors.surfaceRaised,
        items: sig.options.map((o) => DropdownMenuItem(value: o, child: Text(o))).toList(),
        onChanged: (v) => setState(() => _enumValue = v ?? ''),
      );
    }
    return TextField(
      controller: _value,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
      decoration: const InputDecoration(hintText: 'value'),
    );
  }

  Widget _lbl(String s) => Padding(
        padding: const EdgeInsets.only(bottom: Gap.x2),
        child: Text(s, style: Theme.of(context).textTheme.titleSmall),
      );

  Widget _segmented({required String value, required Map<String, String> options, required ValueChanged<String> onChanged}) {
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
          color: AppColors.surfaceSunken, borderRadius: BorderRadius.circular(Radii.md),
          border: Border.all(color: AppColors.border)),
      child: Row(
        children: options.entries.map((e) {
          final on = e.key == value;
          return Expanded(
            child: GestureDetector(
              onTap: () => onChanged(e.key),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding: const EdgeInsets.symmetric(vertical: 9),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                    color: on ? AppColors.accent : Colors.transparent,
                    borderRadius: BorderRadius.circular(Radii.sm)),
                child: Text(e.value,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w600,
                        color: on ? AppColors.bg : AppColors.textSecondary)),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}
