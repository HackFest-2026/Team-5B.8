import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../core/cache/cache_store.dart';
import '../theme/theme.dart';

// ── formatting helpers ──────────────────────────────────────────────────────
String relativeTime(int ms) {
  if (ms <= 0) return '—';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inSeconds < 60) return '${d.inSeconds}s ago';
  if (d.inMinutes < 60) return '${d.inMinutes}m ago';
  if (d.inHours < 24) return '${d.inHours}h ago';
  return '${d.inDays}d ago';
}

String money(num v, {String symbol = '₹'}) {
  final n = v.abs();
  String body;
  if (n >= 10000000) {
    body = '${(n / 10000000).toStringAsFixed(2)}Cr';
  } else if (n >= 100000) {
    body = '${(n / 100000).toStringAsFixed(2)}L';
  } else if (n >= 1000) {
    body = '${(n / 1000).toStringAsFixed(1)}K';
  } else {
    body = n.toStringAsFixed(n.truncateToDouble() == n ? 0 : 2);
  }
  return '${v < 0 ? '-' : ''}$symbol$body';
}

Color severityColor(String s) {
  switch (s) {
    case 'critical':
      return AppColors.critical;
    case 'warning':
      return AppColors.warning;
    case 'info':
    default:
      return AppColors.info;
  }
}

// ── freshness badge ──────────────────────────────────────────────────────────
/// A tiny row that says when the data was last refreshed and quietly spins when
/// a background revalidation is in flight — the visible payoff of the cache.
class Freshness extends StatelessWidget {
  final DateTime? storedAt;
  final bool refreshing;
  const Freshness({super.key, this.storedAt, this.refreshing = false});

  @override
  Widget build(BuildContext context) {
    final label = refreshing
        ? 'Refreshing…'
        : storedAt == null
            ? 'Live'
            : 'Updated ${relativeTime(storedAt!.millisecondsSinceEpoch)}';
    return Row(mainAxisSize: MainAxisSize.min, children: [
      if (refreshing)
        const SizedBox(
          width: 10, height: 10,
          child: CircularProgressIndicator(strokeWidth: 1.5, color: AppColors.textMuted),
        )
      else
        Container(
          width: 6, height: 6,
          decoration: const BoxDecoration(color: AppColors.success, shape: BoxShape.circle),
        ),
      const SizedBox(width: Gap.x2),
      Text(label, style: Theme.of(context).textTheme.labelSmall),
    ]);
  }
}

// ── generic async-with-cache view ───────────────────────────────────────────
/// Renders a cached async value the smooth way: once there is *any* data
/// (even stale), it stays on screen while fresh data loads — a spinner only
/// ever appears on a true cold start with nothing cached.
class CachedView<T> extends StatelessWidget {
  const CachedView({
    super.key,
    required this.value,
    required this.builder,
    this.onRetry,
    this.emptyBuilder,
  });

  final AsyncValue<Cached<T>> value;
  final Widget Function(BuildContext context, T data, bool refreshing) builder;
  final VoidCallback? onRetry;
  final Widget Function(BuildContext context)? emptyBuilder;

  @override
  Widget build(BuildContext context) {
    final cached = value.value;
    if (cached != null) {
      return builder(context, cached.data, value.isLoading || cached.stale);
    }
    if (value.isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(Gap.x7),
          child: CircularProgressIndicator(),
        ),
      );
    }
    return ErrorState(
      message: value.hasError ? '${value.error}' : 'Nothing to show yet.',
      onRetry: onRetry,
    );
  }
}

// ── building blocks ──────────────────────────────────────────────────────────
class SectionCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const SectionCard({super.key, required this.child, this.padding = const EdgeInsets.all(Gap.x4)});
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: padding,
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(Radii.lg),
          border: Border.all(color: AppColors.border),
        ),
        child: child,
      );
}

class SectionLabel extends StatelessWidget {
  final String text;
  final Widget? trailing;
  const SectionLabel(this.text, {super.key, this.trailing});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: Gap.x3),
        child: Row(children: [
          Text(text.toUpperCase(),
              style: GoogleFonts.jetBrainsMono(
                  fontSize: 11, letterSpacing: 1.2, color: AppColors.textMuted)),
          const Spacer(),
          ?trailing,
        ]),
      );
}

class MetricTile extends StatelessWidget {
  final String label, value;
  final String? delta;
  final Color? deltaColor;
  final IconData? icon;
  const MetricTile({
    super.key, required this.label, required this.value,
    this.delta, this.deltaColor, this.icon,
  });
  @override
  Widget build(BuildContext context) {
    return SectionCard(
      padding: const EdgeInsets.all(Gap.x4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (icon != null) ...[
            Icon(icon, size: 15, color: AppColors.textMuted),
            const SizedBox(width: Gap.x2),
          ],
          Expanded(
            child: Text(label,
                style: Theme.of(context).textTheme.bodySmall, overflow: TextOverflow.ellipsis),
          ),
        ]),
        const SizedBox(height: Gap.x3),
        Text(value,
            style: GoogleFonts.jetBrainsMono(
                fontSize: 22, fontWeight: FontWeight.w600, color: AppColors.text),
            maxLines: 1, overflow: TextOverflow.ellipsis),
        if (delta != null) ...[
          const SizedBox(height: Gap.x1),
          Text(delta!,
              style: GoogleFonts.jetBrainsMono(
                  fontSize: 11, color: deltaColor ?? AppColors.textMuted)),
        ],
      ]),
    );
  }
}

class Pill extends StatelessWidget {
  final String text;
  final Color color;
  final bool filled;
  const Pill(this.text, {super.key, required this.color, this.filled = false});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: Gap.x3, vertical: 5),
        decoration: BoxDecoration(
          color: filled ? color : color.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(Radii.pill),
          border: Border.all(color: color.withValues(alpha: filled ? 1 : 0.4)),
        ),
        child: Text(text,
            style: GoogleFonts.jetBrainsMono(
                fontSize: 10.5,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.4,
                color: filled ? AppColors.bg : color)),
      );
}

class StatusDot extends StatelessWidget {
  final Color color;
  final double size;
  const StatusDot(this.color, {super.key, this.size = 8});
  @override
  Widget build(BuildContext context) => Container(
        width: size, height: size,
        decoration: BoxDecoration(
          color: color, shape: BoxShape.circle,
          boxShadow: [BoxShadow(color: color.withValues(alpha: 0.5), blurRadius: 6, spreadRadius: 1)],
        ),
      );
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title, subtitle;
  const EmptyState({super.key, required this.icon, required this.title, required this.subtitle});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(Gap.x6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Container(
              padding: const EdgeInsets.all(Gap.x4),
              decoration: BoxDecoration(
                color: AppColors.surface, shape: BoxShape.circle,
                border: Border.all(color: AppColors.border),
              ),
              child: Icon(icon, size: 26, color: AppColors.textMuted),
            ),
            const SizedBox(height: Gap.x4),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Gap.x2),
            Text(subtitle,
                textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
      );
}

class ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;
  const ErrorState({super.key, required this.message, this.onRetry});
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(Gap.x6),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.cloud_off_rounded, size: 26, color: AppColors.textMuted),
            const SizedBox(height: Gap.x3),
            Text(message,
                textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
            if (onRetry != null) ...[
              const SizedBox(height: Gap.x4),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded, size: 18),
                label: const Text('Retry'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 42)),
              ),
            ],
          ]),
        ),
      );
}
