import 'package:flutter_test/flutter_test.dart';
import 'package:nexus/widgets/widgets.dart';

void main() {
  group('money formatting', () {
    test('compacts large numbers', () {
      expect(money(1500, symbol: '₹'), '₹1.5K');
      expect(money(250000, symbol: '₹'), '₹2.50L');
      expect(money(12000000, symbol: '₹'), '₹1.20Cr');
    });
    test('keeps small numbers exact', () {
      expect(money(0, symbol: '₹'), '₹0');
      expect(money(99.5, symbol: '₹'), '₹99.50');
    });
  });

  group('relativeTime', () {
    test('handles empty timestamps', () {
      expect(relativeTime(0), '—');
    });
  });
}
