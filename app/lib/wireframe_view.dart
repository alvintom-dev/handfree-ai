import 'package:flutter/material.dart';

import 'blocks.dart';
import 'detail_view.dart' show inlineSpan;

// ```wireframe screen sketches, drawn with plain widgets the way the web page draws
// them (daemon/public/blocks.js and the .wf styles in index.html). Several screens
// sit side by side and swipe sideways; pinned notes are listed underneath.

class WireframeView extends StatelessWidget {
  const WireframeView(this.wire, {super.key});
  final WireframeSeg wire;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return LayoutBuilder(builder: (context, box) {
      final screens = [for (final s in wire.screens) _Screen(s, width: _width(s.frame, box.maxWidth))];
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (screens.length == 1)
          Center(child: screens.single)
        else ...[
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(bottom: 4, top: 8, right: 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final (i, s) in screens.indexed) ...[
                if (i > 0) Padding(padding: const EdgeInsets.fromLTRB(6, 180, 6, 0), child: Text('→', style: TextStyle(fontSize: 20, color: cs.onSurfaceVariant))),
                s,
              ],
            ]),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('${screens.length} screens · swipe sideways', style: t.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
          ),
        ],
        if (wire.notes.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(children: [
              for (final (i, n) in wire.notes.indexed)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    _Pin(i + 1),
                    const SizedBox(width: 8),
                    Expanded(child: Text.rich(inlineSpan(n, t.textTheme.bodySmall))),
                  ]),
                ),
            ]),
          ),
      ]);
    });
  }

  static double _width(String frame, double max) => switch (frame) {
        'browser' => max,
        'tablet' => max < 360 ? max : 360,
        _ => max < 250 ? max : 250,
      };
}

class _Pin extends StatelessWidget {
  const _Pin(this.n);
  final int n;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return CircleAvatar(radius: 9, backgroundColor: cs.tertiary, child: Text('$n', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: cs.onTertiary)));
  }
}

class _Screen extends StatelessWidget {
  const _Screen(this.s, {required this.width});
  final WireScreen s;
  final double width;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final browser = s.frame == 'browser';
    final side = s.side.isEmpty ? null : _Side(s.side, width: browser ? 110 : null);
    final body = Stack(children: [
      ConstrainedBox(
        constraints: BoxConstraints(minHeight: browser ? 240 : (s.frame == 'tablet' ? 400 : 360), minWidth: double.infinity),
        child: Padding(
          padding: EdgeInsets.fromLTRB(8, 6, 8, s.fab.isEmpty ? 8 : 58),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final (i, e) in s.body.indexed) Padding(padding: EdgeInsets.only(top: i == 0 ? 0 : 8), child: _Element(e)),
          ]),
        ),
      ),
      for (final f in s.fab)
        Positioned(
          right: 10,
          bottom: 10,
          child: _Noted(
            f.note,
            CircleAvatar(radius: 20, backgroundColor: cs.primary, child: Text(f.a.isEmpty ? '+' : f.a, style: TextStyle(fontSize: 18, color: cs.onPrimary))),
          ),
        ),
    ]);
    final nav = [for (final n in s.nav) _Noted(n.note, _Nav(n, top: !browser))];
    final frame = Container(
      width: width,
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.onSurfaceVariant, width: 1.5),
        borderRadius: BorderRadius.circular(browser ? 10 : (s.frame == 'tablet' ? 20 : 26)),
      ),
      clipBehavior: Clip.antiAlias,
      padding: browser ? null : const EdgeInsets.fromLTRB(6, 6, 6, 8),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (browser) ...[
          Container(
            color: cs.surfaceContainerLow,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            child: Row(children: [
              for (var i = 0; i < 3; i++) Container(width: 8, height: 8, margin: const EdgeInsets.only(right: 4), decoration: BoxDecoration(shape: BoxShape.circle, color: cs.outlineVariant)),
              const SizedBox(width: 6),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(5)),
                  child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                ),
              ),
            ]),
          ),
          ...nav,
          side == null ? body : Row(crossAxisAlignment: CrossAxisAlignment.start, children: [side, Expanded(child: body)]),
        ] else ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text('9:41', style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant)),
              Text('▮▮▮', style: TextStyle(fontSize: 10, color: cs.onSurfaceVariant)),
            ]),
          ),
          ?side,
          body,
          ...nav,
        ],
      ]),
    );
    if (browser || s.title.isEmpty) return frame;
    return Column(mainAxisSize: MainAxisSize.min, children: [
      frame,
      Padding(padding: const EdgeInsets.only(top: 6), child: Text(s.title, style: t.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant, fontWeight: FontWeight.w600))),
    ]);
  }
}

/// An element with a pinned note number on its corner.
class _Noted extends StatelessWidget {
  const _Noted(this.note, this.child);
  final int? note;
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      note == null ? child : Stack(clipBehavior: Clip.none, children: [child, Positioned(top: -7, right: -7, child: _Pin(note!))]);
}

class _Element extends StatelessWidget {
  const _Element(this.e);
  final WireItem e;

  @override
  Widget build(BuildContext context) => _Noted(e.note, _draw(context));

  Widget _draw(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final line = cs.outlineVariant;
    final muted = cs.onSurfaceVariant;
    final small = TextStyle(fontSize: 12, color: muted);
    Text txt(String s, [TextStyle? style]) => Text.rich(inlineSpan(s, style ?? const TextStyle(fontSize: 13)));
    BoxDecoration boxed({Color? color, Color? border, double radius = 8}) =>
        BoxDecoration(color: color, border: Border.all(color: border ?? line, width: 1.5), borderRadius: BorderRadius.circular(radius));
    Widget dash(String label, {double? height}) => Container(
          height: height,
          padding: const EdgeInsets.all(8),
          alignment: Alignment.center,
          decoration: boxed(color: cs.surfaceContainerLow, border: muted.withValues(alpha: 0.6)),
          child: txt(label, small),
        );
    final a = e.a;
    final b = e.b;
    if (!e.known) return dash(e.line);
    final on = e.main || starred(a);
    Widget ctl(Widget mark) => Row(children: [mark, const SizedBox(width: 8), Expanded(child: txt(unstar(a)))]);
    return switch (e.kind) {
      'bar' => Container(
          padding: const EdgeInsets.only(bottom: 8, top: 2),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: line))),
          child: Row(children: [
            Text('‹', style: TextStyle(fontSize: 16, color: muted)),
            const SizedBox(width: 8),
            Expanded(child: txt(a, const TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
            txt(b.isEmpty ? '⋯' : b, TextStyle(fontSize: 13, color: muted)),
          ]),
        ),
      'header' || 'title' => txt(a, const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, height: 1.25)),
      'text' => a.isNotEmpty
          ? txt(a, small)
          : Column(children: [
              for (final w in [1.0, 1.0, 0.6])
                FractionallySizedBox(
                  widthFactor: w,
                  child: Container(height: 6, margin: const EdgeInsets.symmetric(vertical: 2.5), decoration: BoxDecoration(color: line, borderRadius: BorderRadius.circular(3))),
                ),
            ]),
      'input' || 'search' || 'select' => Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: boxed(color: cs.surfaceContainerLow),
          child: Row(children: [
            Expanded(child: txt(e.kind == 'search' ? '⌕ ${a.isEmpty ? 'Search' : a}' : a, TextStyle(fontSize: 12.5, color: muted))),
            if (e.kind == 'select') Text('▾', style: TextStyle(color: muted)),
          ]),
        ),
      'button' => Container(
          padding: const EdgeInsets.all(8),
          alignment: Alignment.center,
          decoration: boxed(color: on ? cs.primary : null, border: on ? cs.primary : muted),
          child: txt(unstar(a), TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: on ? cs.onPrimary : null)),
        ),
      'link' => Center(child: txt(a, TextStyle(fontSize: 12.5, color: cs.primary, decoration: TextDecoration.underline, decorationColor: cs.primary))),
      'image' => dash(a, height: ((int.tryParse(b) ?? 110).clamp(40, 400)).toDouble()),
      'card' => Container(
          padding: const EdgeInsets.all(8),
          decoration: boxed(radius: 10),
          child: Row(children: [
            Container(width: 44, height: 44, decoration: BoxDecoration(color: line, borderRadius: BorderRadius.circular(6))),
            const SizedBox(width: 10),
            Expanded(child: _twoLines(a, b, small)),
          ]),
        ),
      'avatar' => Row(children: [
          CircleAvatar(radius: 20, backgroundColor: line),
          const SizedBox(width: 10),
          Expanded(child: _twoLines(a, b, small)),
        ]),
      'list' => Column(children: [
          for (final item in e.args)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 2),
              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: line))),
              child: Row(children: [
                CircleAvatar(radius: 11, backgroundColor: line),
                const SizedBox(width: 8),
                Expanded(child: txt(item)),
                Text('›', style: TextStyle(color: muted)),
              ]),
            ),
        ]),
      'tabs' => Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(color: cs.surfaceContainerLow, borderRadius: BorderRadius.circular(8)),
          child: Row(children: [
            for (final tab in e.args)
              Expanded(
                child: Container(
                  padding: const EdgeInsets.all(5),
                  alignment: Alignment.center,
                  decoration: starred(tab) ? BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(6), boxShadow: const [BoxShadow(color: Color(0x26000000), blurRadius: 2, offset: Offset(0, 1))]) : null,
                  child: txt(unstar(tab), TextStyle(fontSize: 12, color: starred(tab) ? cs.onSurface : muted, fontWeight: starred(tab) ? FontWeight.w600 : null)),
                ),
              ),
          ]),
        ),
      'chips' => Wrap(spacing: 4, runSpacing: 4, children: [
          for (final chip in e.args)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              decoration: BoxDecoration(
                color: starred(chip) ? cs.primaryContainer : null,
                border: Border.all(color: starred(chip) ? cs.primary : line),
                borderRadius: BorderRadius.circular(999),
              ),
              child: txt(unstar(chip), TextStyle(fontSize: 12, color: starred(chip) ? cs.primary : muted)),
            ),
        ]),
      // in a row cell; on their own they sit at the frame's edge (_Screen)
      'nav' => _Nav(e, top: false),
      'sidebar' => _Side([e]),
      'toggle' => ctl(Container(
          width: 30,
          height: 17,
          padding: const EdgeInsets.all(2),
          alignment: on ? Alignment.centerRight : Alignment.centerLeft,
          decoration: BoxDecoration(color: on ? cs.primary : line, borderRadius: BorderRadius.circular(9)),
          child: CircleAvatar(radius: 6.5, backgroundColor: cs.surface),
        )),
      'check' || 'radio' => ctl(Container(
          width: 15,
          height: 15,
          decoration: BoxDecoration(
            color: on ? cs.primary : null,
            border: Border.all(color: on ? cs.primary : muted, width: 1.5),
            borderRadius: e.kind == 'radio' ? BorderRadius.circular(8) : BorderRadius.circular(4),
          ),
        )),
      'divider' => Divider(height: 4, color: line),
      'space' => const SizedBox(height: 12),
      'grid' => LayoutBuilder(builder: (_, box) {
          final cols = (box.maxWidth / 90).floor().clamp(1, 6);
          final w = (box.maxWidth - 8 * (cols - 1)) / cols;
          return Wrap(spacing: 8, runSpacing: 8, children: [
            for (final g in e.args)
              Container(
                width: w,
                height: w / 1.3,
                padding: const EdgeInsets.all(4),
                alignment: Alignment.center,
                decoration: boxed(),
                child: Text.rich(inlineSpan(g, small), textAlign: TextAlign.center),
              ),
          ]);
        }),
      'table' => Container(
          decoration: boxed(),
          clipBehavior: Clip.antiAlias,
          child: Column(children: [
            for (var r = 0; r < 4; r++)
              Container(
                color: r == 0 ? cs.surfaceContainerLow : null,
                decoration: null,
                child: Row(children: [
                  for (final col in e.args)
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                        decoration: r == 0 ? null : BoxDecoration(border: Border(top: BorderSide(color: line))),
                        child: r == 0
                            ? txt(col, const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))
                            : FractionallySizedBox(
                                alignment: Alignment.centerLeft,
                                widthFactor: 0.7,
                                child: Container(height: 6, margin: const EdgeInsets.symmetric(vertical: 4), decoration: BoxDecoration(color: line, borderRadius: BorderRadius.circular(3))),
                              ),
                      ),
                    ),
                ]),
              ),
          ]),
        ),
      'fab' => Align(
          alignment: Alignment.centerRight,
          child: CircleAvatar(radius: 20, backgroundColor: cs.primary, child: Text(a.isEmpty ? '+' : a, style: TextStyle(fontSize: 18, color: cs.onPrimary))),
        ),
      'row' => Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final (i, cell) in e.args.indexed) ...[
            if (i > 0) const SizedBox(width: 8),
            Expanded(child: _Element(wireLine(cell))),
          ],
        ]),
      _ => dash(e.line), // a frame word inside a row
    };
  }

  Widget _twoLines(String a, String b, TextStyle small) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text.rich(inlineSpan(a, const TextStyle(fontSize: 13, fontWeight: FontWeight.w700))),
        if (b.isNotEmpty) Text.rich(inlineSpan(b, small)),
      ]);
}

/// Bottom tabs on a phone, a top menu in a browser.
class _Nav extends StatelessWidget {
  const _Nav(this.e, {required this.top});
  final WireItem e;
  final bool top; // a border above: the phone's bottom bar

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: top ? const EdgeInsets.fromLTRB(4, 8, 4, 2) : const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(border: top ? Border(top: BorderSide(color: cs.outlineVariant)) : Border(bottom: BorderSide(color: cs.outlineVariant))),
      child: Row(children: [
        for (final tab in e.args)
          if (top)
            Expanded(
              child: Column(children: [
                Container(width: 18, height: 18, decoration: BoxDecoration(color: starred(tab) ? cs.primary : cs.outlineVariant, borderRadius: BorderRadius.circular(5))),
                const SizedBox(height: 3),
                Text.rich(
                  inlineSpan(unstar(tab), TextStyle(fontSize: 10.5, color: starred(tab) ? cs.primary : cs.onSurfaceVariant, fontWeight: starred(tab) ? FontWeight.w600 : null)),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ]),
            )
          else
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Text.rich(inlineSpan(unstar(tab), TextStyle(fontSize: 12, color: starred(tab) ? cs.primary : cs.onSurfaceVariant, fontWeight: starred(tab) ? FontWeight.w600 : null))),
            ),
      ]),
    );
  }
}

/// A side menu: a column beside the page in a browser, a list at the top on a phone.
class _Side extends StatelessWidget {
  const _Side(this.items, {this.width});
  final List<WireItem> items;
  final double? width;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: width,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
      decoration: BoxDecoration(color: cs.surfaceContainerLow, border: width == null ? null : Border(right: BorderSide(color: cs.outlineVariant))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final e in items)
          _Noted(
            e.note,
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final tab in e.args)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                  decoration: starred(tab) ? BoxDecoration(color: cs.primaryContainer, borderRadius: BorderRadius.circular(6)) : null,
                  child: Text.rich(inlineSpan(unstar(tab), TextStyle(fontSize: 12, color: starred(tab) ? cs.primary : cs.onSurfaceVariant, fontWeight: starred(tab) ? FontWeight.w600 : null))),
                ),
            ]),
          ),
      ]),
    );
  }
}
