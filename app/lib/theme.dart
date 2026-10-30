import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

// The web dashboard's colours (daemon/public/index.html :root), so the phone and
// the Mac page look like one app.

@immutable
class Hf extends ThemeExtension<Hf> {
  const Hf({
    required this.bg,
    required this.card,
    required this.line,
    required this.fg,
    required this.muted,
    required this.accent,
    required this.accentSoft,
    required this.onAccent,
    required this.warn,
    required this.warnSoft,
    required this.bad,
    required this.badSoft,
    required this.violet,
    required this.violetSoft,
    required this.idle,
    required this.shadow,
  });

  final Color bg, card, line, fg, muted, accent, accentSoft, onAccent, warn, warnSoft, bad, badSoft, violet, violetSoft, idle, shadow;
  Color get good => accent;
  static const recording = Color(0xFFE5484D);
  /// the mic is listening but waits for the wake phrase (green: awake, what you say goes to Claude)
  static const ready = Color(0xFFE3A008);

  static const light = Hf(
    bg: Color(0xFFF3F4F1), card: Color(0xFFFFFFFF), line: Color(0xFFE1E4DE), fg: Color(0xFF1B2420), muted: Color(0xFF58655E),
    accent: Color(0xFF2E7D67), accentSoft: Color(0xFFE2F0EA), onAccent: Color(0xFFFFFFFF), warn: Color(0xFFA35A00), warnSoft: Color(0xFFFFF1DC),
    bad: Color(0xFFB91C1C), badSoft: Color(0xFFFEE2E2), violet: Color(0xFF6D4FC2), violetSoft: Color(0xFFEEE9FB), idle: Color(0xFF8A948F),
    shadow: Color(0x14141E19),
  );

  static const dark = Hf(
    bg: Color(0xFF111513), card: Color(0xFF191E1B), line: Color(0xFF2A312D), fg: Color(0xFFE8EDEA), muted: Color(0xFF9AA8A0),
    accent: Color(0xFF6CC4A8), accentSoft: Color(0xFF1F3129), onAccent: Color(0xFF0B1410), warn: Color(0xFFF0A848), warnSoft: Color(0xFF33270F),
    bad: Color(0xFFF87171), badSoft: Color(0xFF3B1515), violet: Color(0xFFA78BFA), violetSoft: Color(0xFF2E2350), idle: Color(0xFF7D8A83),
    shadow: Color(0x59000000),
  );

  static Hf of(BuildContext context) {
    final t = Theme.of(context);
    return t.extension<Hf>() ?? (t.brightness == Brightness.dark ? dark : light);
  }

  @override
  Hf copyWith() => this;

  @override
  Hf lerp(Hf? other, double t) => t < 0.5 || other == null ? this : other;
}

ThemeData buildTheme(Brightness b) {
  final h = b == Brightness.dark ? Hf.dark : Hf.light;
  final scheme = ColorScheme(
    brightness: b,
    primary: h.accent,
    onPrimary: h.onAccent,
    primaryContainer: h.accentSoft,
    onPrimaryContainer: h.fg,
    secondary: h.accent,
    onSecondary: h.onAccent,
    secondaryContainer: h.accentSoft,
    onSecondaryContainer: h.fg,
    tertiary: h.violet,
    onTertiary: h.onAccent,
    tertiaryContainer: h.violetSoft,
    onTertiaryContainer: h.fg,
    error: h.bad,
    onError: Colors.white,
    errorContainer: h.badSoft,
    onErrorContainer: h.fg,
    surface: h.card,
    onSurface: h.fg,
    onSurfaceVariant: h.muted,
    surfaceContainerLowest: h.card,
    surfaceContainerLow: h.card,
    surfaceContainer: h.card,
    surfaceContainerHigh: h.card,
    surfaceContainerHighest: h.bg,
    outline: h.idle,
    outlineVariant: h.line,
    shadow: Colors.black,
    inverseSurface: h.fg,
    onInverseSurface: h.card,
    inversePrimary: h.accentSoft,
  );
  final round12 = RoundedRectangleBorder(borderRadius: BorderRadius.circular(12));
  final round10 = RoundedRectangleBorder(borderRadius: BorderRadius.circular(10));
  return ThemeData(
    useMaterial3: true,
    brightness: b,
    colorScheme: scheme,
    scaffoldBackgroundColor: h.bg,
    canvasColor: h.bg,
    dividerColor: h.line,
    extensions: [h],
    appBarTheme: AppBarTheme(
      backgroundColor: h.card,
      foregroundColor: h.fg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      shape: Border(bottom: BorderSide(color: h.line)),
      titleTextStyle: TextStyle(color: h.fg, fontSize: 17, fontWeight: FontWeight.w700),
    ),
    drawerTheme: DrawerThemeData(backgroundColor: h.card, surfaceTintColor: Colors.transparent, scrimColor: const Color(0x610A100D), shape: const RoundedRectangleBorder()),
    dialogTheme: DialogThemeData(backgroundColor: h.card, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: h.line))),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: h.card, surfaceTintColor: Colors.transparent),
    popupMenuTheme: PopupMenuThemeData(color: h.card, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: h.line))),
    cardTheme: CardThemeData(color: h.card, surfaceTintColor: Colors.transparent, elevation: 0, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: h.line))),
    snackBarTheme: SnackBarThemeData(backgroundColor: h.fg, contentTextStyle: TextStyle(color: h.card)),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: h.accent, foregroundColor: h.onAccent, shape: round10, minimumSize: const Size(44, 44), textStyle: const TextStyle(fontWeight: FontWeight.w600))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: h.fg, backgroundColor: h.card, side: BorderSide(color: h.line), shape: round10, minimumSize: const Size(44, 44), textStyle: const TextStyle(fontWeight: FontWeight.w600))),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: h.accent, shape: round10, textStyle: const TextStyle(fontWeight: FontWeight.w600))),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? h.accentSoft : h.card),
        foregroundColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? h.fg : h.muted),
        side: WidgetStatePropertyAll(BorderSide(color: h.line)),
        shape: WidgetStatePropertyAll(round12),
        textStyle: const WidgetStatePropertyAll(TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
      ),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: const WidgetStatePropertyAll(Colors.white),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? h.accent : h.idle),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: h.card,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      hintStyle: TextStyle(color: h.muted),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: h.line)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: h.line)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: h.accent, width: 2)),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: h.accent),
    listTileTheme: ListTileThemeData(iconColor: h.muted, textColor: h.fg),
  );
}

/// Look settings kept on the phone: theme (auto follows the phone) and text size.
class LookPrefs extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();
  String theme = 'auto'; // auto | light | dark
  bool large = false;

  ThemeMode get mode => switch (theme) { 'light' => ThemeMode.light, 'dark' => ThemeMode.dark, _ => ThemeMode.system };

  Future<void> load() async {
    theme = await _storage.read(key: 'handfree.theme') ?? 'auto';
    large = await _storage.read(key: 'handfree.large') == 'on';
    notifyListeners();
  }

  void setTheme(String v) {
    theme = v;
    _storage.write(key: 'handfree.theme', value: v);
    notifyListeners();
  }

  void setLarge(bool on) {
    large = on;
    _storage.write(key: 'handfree.large', value: on ? 'on' : 'off');
    notifyListeners();
  }
}

final lookPrefs = LookPrefs();
