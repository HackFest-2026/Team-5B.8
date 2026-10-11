import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/actions.dart';
import '../../data/live_providers.dart';
import '../../theme/theme.dart';
import 'alerts_tab.dart';
import 'audit_tab.dart';
import 'project_settings_screen.dart';
import 'overview_tab.dart';
import 'rules_guards_tab.dart';

/// The project-level workspace. Bottom navigation lives *here* (not on the
/// general dashboard). One WebSocket stays up across all four tabs — the shell
/// watches [liveSocketProvider] so it is created on entry and torn down on exit.
class ProjectShell extends ConsumerStatefulWidget {
  final String projectId, projectName;
  const ProjectShell({super.key, required this.projectId, required this.projectName});
  @override
  ConsumerState<ProjectShell> createState() => _ProjectShellState();
}

class _ProjectShellState extends ConsumerState<ProjectShell> {
  int _index = 0;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    // Keep rules/alerts/audit fresh across the project without a manual pull.
    _poll = Timer.periodic(const Duration(seconds: 7),
        (_) => ref.read(projectActionsProvider).refreshTabs(widget.projectId));
  }

  @override
  void dispose() { _poll?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final pid = widget.projectId;
    // Keep the socket alive for the lifetime of this screen.
    ref.watch(liveSocketProvider(pid));
    final connected = ref.watch(liveConnectedProvider(pid));

    final tabs = [
      OverviewTab(projectId: pid, projectName: widget.projectName),
      RulesGuardsTab(projectId: pid),
      AlertsTab(projectId: pid),
      AuditTab(projectId: pid),
    ];

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        actions: [
          IconButton(
            tooltip: 'Project settings',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => ProjectSettingsScreen(
                  projectId: widget.projectId, projectName: widget.projectName),
            )),
          ),
        ],
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.projectName,
                style: Theme.of(context).textTheme.titleLarge,
                maxLines: 1, overflow: TextOverflow.ellipsis),
            Row(children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                width: 6, height: 6,
                decoration: BoxDecoration(
                  color: connected ? AppColors.success : AppColors.textMuted,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Text(connected ? 'Live' : 'Reconnecting…',
                  style: Theme.of(context).textTheme.labelSmall),
            ]),
          ],
        ),
      ),
      body: IndexedStack(index: _index, children: tabs),
      bottomNavigationBar: NavigationBarTheme(
        data: NavigationBarThemeData(
          backgroundColor: AppColors.bgSubtle,
          indicatorColor: AppColors.accentMuted,
          labelTextStyle: WidgetStateProperty.all(
            const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
          ),
        ),
        child: NavigationBar(
          selectedIndex: _index,
          height: 64,
          onDestinationSelected: (i) => setState(() => _index = i),
          destinations: const [
            NavigationDestination(
                icon: Icon(Icons.insights_outlined),
                selectedIcon: Icon(Icons.insights_rounded, color: AppColors.accentText),
                label: 'Overview'),
            NavigationDestination(
                icon: Icon(Icons.tune_outlined),
                selectedIcon: Icon(Icons.tune_rounded, color: AppColors.accentText),
                label: 'Rules'),
            NavigationDestination(
                icon: Icon(Icons.notifications_outlined),
                selectedIcon: Icon(Icons.notifications_rounded, color: AppColors.accentText),
                label: 'Alerts'),
            NavigationDestination(
                icon: Icon(Icons.receipt_long_outlined),
                selectedIcon: Icon(Icons.receipt_long_rounded, color: AppColors.accentText),
                label: 'Audit'),
          ],
        ),
      ),
    );
  }
}
