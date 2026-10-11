import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../data/models.dart';
import '../../data/providers.dart';
import '../../data/repository.dart';
import '../../theme/theme.dart';
import '../../widgets/widgets.dart';
import '../dashboard/dashboard_screen.dart' show currencySymbol;

/// Read-only catalogue view. The app never creates or edits products.
class ProductsScreen extends ConsumerWidget {
  final String projectId, projectName;
  const ProductsScreen({super.key, required this.projectId, required this.projectName});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sym = currencySymbol(
        ref.watch(authControllerProvider).value?.currency ?? 'INR');
    final items = ref.watch(itemsProvider(projectId));
    return Scaffold(
      appBar: AppBar(title: const Text('Products')),
      body: RefreshIndicator(
        color: AppColors.accent,
        backgroundColor: AppColors.surface,
        onRefresh: () async =>
            ref.read(cacheStoreProvider).refresh(CacheKeys.items(projectId),
                () => ref.read(fetchersProvider).items(projectId)),
        child: CachedView<List<Item>>(
          value: items,
          builder: (context, list, _) {
            if (list.isEmpty) {
              return ListView(children: const [
                SizedBox(height: Gap.x7),
                EmptyState(
                  icon: Icons.inventory_2_outlined,
                  title: 'No products',
                  subtitle: 'This project has no catalogue items yet.',
                ),
              ]);
            }
            return ListView.separated(
              padding: const EdgeInsets.fromLTRB(Gap.x4, Gap.x4, Gap.x4, Gap.x7),
              itemCount: list.length,
              separatorBuilder: (_, _) => const SizedBox(height: Gap.x2),
              itemBuilder: (context, i) {
                final it = list[i];
                final hasCost = it.cost > 0;
                final margin = hasCost && it.basePrice > 0
                    ? ((it.basePrice - it.cost) / it.basePrice * 100)
                    : null;
                return SectionCard(
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(it.name,
                            style: Theme.of(context).textTheme.titleSmall?.copyWith(color: AppColors.text),
                            maxLines: 1, overflow: TextOverflow.ellipsis),
                        const SizedBox(height: 2),
                        Text(it.id,
                            style: GoogleFonts.jetBrainsMono(fontSize: 11, color: AppColors.textMuted)),
                      ]),
                    ),
                    Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                      Text(money(it.basePrice, symbol: sym),
                          style: GoogleFonts.jetBrainsMono(
                              fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.text)),
                      if (margin != null) ...[
                        const SizedBox(height: 2),
                        Text('${margin.toStringAsFixed(0)}% margin',
                            style: GoogleFonts.jetBrainsMono(fontSize: 11, color: AppColors.successText)),
                      ],
                    ]),
                  ]),
                );
              },
            );
          },
        ),
      ),
    );
  }
}
