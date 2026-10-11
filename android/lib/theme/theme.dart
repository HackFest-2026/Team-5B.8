import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

/// The one source of colour. Mirrors the web app's dark identity exactly
/// (tokens.css): near-black canvas, graphite surfaces, a single amber accent.
/// There is no light theme — the app is dark by design.
class AppColors {
  static const bg = Color(0xFF0A0A0B);
  static const bgSubtle = Color(0xFF0E0E10);
  static const surface = Color(0xFF141416);
  static const surfaceRaised = Color(0xFF1A1A1D);
  static const surfaceSunken = Color(0xFF080809);
  static const surfaceHover = Color(0xFF1F1F23);

  static const border = Color(0xFF232327);
  static const borderStrong = Color(0xFF32323A);
  static const borderSubtle = Color(0xFF1A1A1E);

  static const text = Color(0xFFF4F4F5);
  static const textSecondary = Color(0xFFA1A1AA);
  static const textMuted = Color(0xFF6B6B74);

  static const accent = Color(0xFFE8A33D);
  static const accentHover = Color(0xFFF0B355);
  static const accentText = Color(0xFFF0B355);
  static const accentMuted = Color(0x24E8A33D); // 0.14 alpha

  static const success = Color(0xFF4EA172);
  static const successText = Color(0xFF6ABD8D);
  static const successMuted = Color(0x244EA172);

  static const warning = Color(0xFFD99A2B);
  static const warningText = Color(0xFFE5AB45);
  static const warningMuted = Color(0x24D99A2B);

  static const critical = Color(0xFFD2544F);
  static const criticalText = Color(0xFFE5726D);
  static const criticalMuted = Color(0x24D2544F);

  static const info = Color(0xFF5A8FB5);
  static const infoText = Color(0xFF74A4C7);
  static const infoMuted = Color(0x245A8FB5);
}

/// Spacing scale, mirroring the web --s-* tokens (a 4px base).
class Gap {
  static const x1 = 4.0, x2 = 8.0, x3 = 12.0, x4 = 16.0, x5 = 24.0, x6 = 32.0, x7 = 48.0;
}

class Radii {
  static const sm = 6.0, md = 10.0, lg = 14.0, xl = 20.0, pill = 999.0;
}

ThemeData buildDarkTheme() {
  // A distinctive, premium pairing — geometric display + humanist body + a
  // technical mono for every number. Deliberately not Inter/Roboto.
  final display = GoogleFonts.sora();
  final body = GoogleFonts.manrope();
  final mono = GoogleFonts.jetBrainsMono();

  const scheme = ColorScheme.dark(
    primary: AppColors.accent,
    onPrimary: AppColors.bg,
    secondary: AppColors.accentText,
    surface: AppColors.surface,
    onSurface: AppColors.text,
    error: AppColors.critical,
    onError: AppColors.text,
    outline: AppColors.border,
  );

  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.bg,
    canvasColor: AppColors.bg,
    splashFactory: InkSparkle.splashFactory,
    textTheme: TextTheme(
      displaySmall: display.copyWith(fontWeight: FontWeight.w700, color: AppColors.text, letterSpacing: -0.5),
      headlineMedium: display.copyWith(fontWeight: FontWeight.w700, color: AppColors.text, letterSpacing: -0.4),
      headlineSmall: display.copyWith(fontWeight: FontWeight.w600, color: AppColors.text, letterSpacing: -0.3),
      titleLarge: display.copyWith(fontWeight: FontWeight.w600, color: AppColors.text, letterSpacing: -0.2),
      titleMedium: body.copyWith(fontWeight: FontWeight.w600, color: AppColors.text),
      titleSmall: body.copyWith(fontWeight: FontWeight.w600, color: AppColors.textSecondary),
      bodyLarge: body.copyWith(color: AppColors.text, height: 1.45),
      bodyMedium: body.copyWith(color: AppColors.textSecondary, height: 1.45),
      bodySmall: body.copyWith(color: AppColors.textMuted, height: 1.4),
      labelLarge: body.copyWith(fontWeight: FontWeight.w600, color: AppColors.text),
      labelSmall: mono.copyWith(color: AppColors.textMuted, letterSpacing: 0.4),
    ),
  );

  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      systemOverlayStyle: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        systemNavigationBarColor: AppColors.bg,
        systemNavigationBarIconBrightness: Brightness.light,
      ),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.border, thickness: 1, space: 1),
    cardTheme: CardThemeData(
      color: AppColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.lg),
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceSunken,
      hintStyle: const TextStyle(color: AppColors.textMuted),
      contentPadding: const EdgeInsets.symmetric(horizontal: Gap.x4, vertical: Gap.x4),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        borderSide: const BorderSide(color: AppColors.borderStrong),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        borderSide: const BorderSide(color: AppColors.accent, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        borderSide: const BorderSide(color: AppColors.critical),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        borderSide: const BorderSide(color: AppColors.critical, width: 1.5),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.accent,
        foregroundColor: AppColors.bg,
        disabledBackgroundColor: AppColors.surfaceHover,
        disabledForegroundColor: AppColors.textMuted,
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.md)),
        textStyle: GoogleFonts.manrope(fontWeight: FontWeight.w700, fontSize: 15),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.text,
        side: const BorderSide(color: AppColors.borderStrong),
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.md)),
      ),
    ),
    bottomNavigationBarTheme: const BottomNavigationBarThemeData(
      backgroundColor: AppColors.bgSubtle,
      selectedItemColor: AppColors.accentText,
      unselectedItemColor: AppColors.textMuted,
      type: BottomNavigationBarType.fixed,
      showUnselectedLabels: true,
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: AppColors.surfaceRaised,
      contentTextStyle: TextStyle(color: AppColors.text),
      behavior: SnackBarBehavior.floating,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: AppColors.accent),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? AppColors.bg : AppColors.textSecondary),
      trackColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? AppColors.accent : AppColors.surfaceHover),
      trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
    ),
    extensions: const [AppMono(TextStyle(fontFamilyFallback: []))],
  );
}

/// A theme extension carrying the mono style, so number-heavy widgets can grab
/// it without re-instantiating GoogleFonts everywhere.
class AppMono extends ThemeExtension<AppMono> {
  final TextStyle style;
  const AppMono(this.style);
  static TextStyle of(BuildContext context) =>
      GoogleFonts.jetBrainsMono(color: AppColors.text);
  @override
  AppMono copyWith({TextStyle? style}) => AppMono(style ?? this.style);
  @override
  AppMono lerp(ThemeExtension<AppMono>? other, double t) => this;
}
