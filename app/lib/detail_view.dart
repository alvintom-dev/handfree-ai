import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'blocks.dart';
import 'diagram_view.dart';
import 'theme.dart';
import 'wireframe_view.dart';

// Detail answers on a small screen: a summary card in the chat, the whole answer
// one tap away on its own page. Same content as the web page, laid out for the phone.

void openLink(String? url) {
  final uri = url == null ? null : Uri.tryParse(url);
  if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// Copy to the clipboard, with a short "Copied" at the bottom.
void copyText(BuildContext context, String text, {String what = 'Copied'}) {
  Clipboard.setData(ClipboardData(text: text));
  HapticFeedback.selectionClick();
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(what), duration: const Duration(milliseconds: 1200), behavior: SnackBarBehavior.floating));
}

Widget _markdown(String text, {bool selectable = true}) =>
    MarkdownBody(data: text, selectable: selectable, builders: {'pre': _CodeBlock()}, onTapLink: (_, href, _) => openLink(href));

/// A code block with its own copy button: a command or a path is one tap away.
class _CodeBlock extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final code = element.textContent.replaceFirst(RegExp(r'\n$'), '');
    return Stack(children: [
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(10, 10, 44, 10),
        child: Text(code, style: (preferredStyle ?? const TextStyle()).copyWith(fontFamily: 'monospace')),
      ),
      Positioned(
        top: 0,
        right: 0,
        child: IconButton(
          onPressed: () => copyText(context, code, what: 'Code copied'),
          icon: const Icon(Icons.copy, size: 16),
          tooltip: 'Copy code',
          visualDensity: VisualDensity.compact,
        ),
      ),
    ]);
  }
}

/// **bold** and `code` inside block cells, without a full markdown pass per cell.
TextSpan inlineSpan(String text, TextStyle? base) {
  final spans = <InlineSpan>[];
  final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+)`');
  var at = 0;
  for (final m in re.allMatches(text)) {
    if (m.start > at) spans.add(TextSpan(text: text.substring(at, m.start)));
    spans.add(m[1] != null
        ? TextSpan(text: m[1], style: const TextStyle(fontWeight: FontWeight.w700))
        : TextSpan(text: m[2], style: const TextStyle(fontFamily: 'monospace')));
    at = m.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return TextSpan(style: base, children: spans);
}

Widget _inline(String text, TextStyle? style, {int? maxLines}) =>
    Text.rich(inlineSpan(text, style), maxLines: maxLines, overflow: maxLines == null ? null : TextOverflow.ellipsis);

/// Strips markdown marks for one-line previews.
String plain(String text) => text.replaceAll(RegExp(r'\*\*|`|__|^#+\s*', multiLine: true), '').replaceAll(RegExp(r'\s+'), ' ').trim();

// --- in the chat ------------------------------------------------------------------------

class DetailCard extends StatelessWidget {
  const DetailCard({super.key, required this.markdown, required this.label, this.onChoice, this.trailing});
  final String markdown;
  final String label;
  /// next to the label, like the pin button
  final Widget? trailing;
  /// A Decide answer was tapped: send it to the session that asked.
  final ValueChanged<String>? onChoice;

  @override
  Widget build(BuildContext context) {
    final doc = DetailDoc.parse(markdown);
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final head = Padding(
      padding: const EdgeInsets.only(bottom: 3),
      child: Text(label, style: t.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
    );
    final copy = IconButton(
      onPressed: () => copyText(context, markdown),
      icon: const Icon(Icons.copy, size: 16),
      tooltip: 'Copy the answer',
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 28),
    );
    if (doc.isSimple) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [Expanded(child: head), copy, ?trailing]),
        _markdown(markdown),
      ]);
    }
    final title = doc.title;
    final tldr = doc.tldr;
    void open() => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DetailPage(doc: doc, title: title ?? label, markdown: markdown, onChoice: onChoice)));
    return InkWell(
      onTap: open,
      onLongPress: () => copyText(context, markdown),
      borderRadius: BorderRadius.circular(8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (trailing == null) head else Row(children: [Expanded(child: head), trailing!]),
        if (title != null) _inline(plain(title), t.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600), maxLines: 2),
        if (tldr != null)
          Padding(padding: const EdgeInsets.only(top: 4), child: _inline(plain(tldr), t.textTheme.bodyMedium, maxLines: 3))
        else if (title == null)
          Text(plain(markdown), maxLines: 3, overflow: TextOverflow.ellipsis, style: t.textTheme.bodyMedium),
        for (final c in doc.mustSee) Padding(padding: const EdgeInsets.only(top: 8), child: CalloutView(c, compact: true, onChoice: onChoice)),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              for (final s in doc.contents)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(color: cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(10)),
                  child: Text(s, style: t.textTheme.labelSmall),
                ),
            ]),
          ),
          copy,
          OutlinedButton.icon(onPressed: open, icon: const Icon(Icons.open_in_full, size: 16), label: const Text('Open')),
        ]),
      ]),
    );
  }
}

// --- full screen ---------------------------------------------------------------------------

class DetailPage extends StatelessWidget {
  const DetailPage({super.key, required this.doc, required this.title, this.markdown, this.onChoice});
  final DetailDoc doc;
  final String title;
  /// the answer as Claude wrote it, for Copy
  final String? markdown;
  final ValueChanged<String>? onChoice;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: Text(plain(title), maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            if (markdown != null)
              Builder(builder: (context) => IconButton(onPressed: () => copyText(context, markdown!), icon: const Icon(Icons.copy), tooltip: 'Copy the answer')),
          ],
        ),
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              for (final s in doc.segments)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: SegmentView(s, onChoice: onChoice == null ? null : (v) {
                    // answered: back to the chat to hear the reply (from a tile's page too)
                    Navigator.of(context).popUntil((r) => r.isFirst);
                    onChoice!(v);
                  }),
                ),
            ],
          ),
        ),
      );
}

class SegmentView extends StatelessWidget {
  const SegmentView(this.segment, {super.key, this.onChoice});
  final Segment segment;
  final ValueChanged<String>? onChoice;

  @override
  Widget build(BuildContext context) => switch (segment) {
        MarkdownSeg(:final text) => _markdown(text),
        CalloutSeg() => CalloutView(segment as CalloutSeg, onChoice: onChoice),
        StatsSeg(:final tiles) => StatsView(tiles),
        StepsSeg(:final steps) => StepsView(steps),
        OptionsSeg(:final options) => OptionsView(options),
        DesignSeg(:final cards) => DesignView(cards),
        TilesSeg(:final tiles) => TilesView(tiles, onChoice: onChoice),
        MermaidSeg(:final source) => DiagramView(source),
        WireframeSeg() => WireframeView(segment as WireframeSeg),
      };
}

// --- blocks ------------------------------------------------------------------------------------

const _calloutLook = {
  'tldr': ('i', 'In short'),
  'note': ('i', 'Note'),
  'tip': ('✓', 'Tip'),
  'warning': ('!', 'Watch out'),
  'decide': ('?', 'Your call'),
};

class CalloutView extends StatelessWidget {
  const CalloutView(this.c, {super.key, this.compact = false, this.onChoice});
  final CalloutSeg c;
  final bool compact;
  final ValueChanged<String>? onChoice;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    // as on the web: a soft fill, a square icon, an uppercase name; Decide gets a purple frame
    final (color, fill) = switch (c.kind) {
      'tip' => (h.good, h.accentSoft),
      'warning' => (h.warn, h.warnSoft),
      'decide' => (h.violet, Colors.transparent),
      _ => (h.accent, h.accentSoft),
    };
    final (icon, name) = _calloutLook[c.kind]!;
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(compact ? 10 : 12),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(10),
        border: c.kind == 'decide' ? Border.all(color: color, width: 2) : null,
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(8)),
          child: Text(icon, style: TextStyle(color: c.kind == 'decide' || c.kind == 'warning' ? Colors.white : h.onAccent, fontSize: 14, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name.toUpperCase(), style: TextStyle(color: color, fontSize: 11.5, letterSpacing: 0.6, fontWeight: FontWeight.w700)),
            if (c.body.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: _markdown(c.body, selectable: !compact)),
            if (c.choices.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final choice in c.choices)
                    Material(
                      color: h.violetSoft,
                      shape: StadiumBorder(side: BorderSide(color: h.violet)),
                      clipBehavior: Clip.antiAlias,
                      child: InkWell(
                        onTap: onChoice == null ? null : () => onChoice!(plain(choice)),
                        child: Container(
                          constraints: const BoxConstraints(minHeight: 40),
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                          child: _inline(choice, TextStyle(fontSize: 14, color: h.fg)),
                        ),
                      ),
                    ),
                ]),
              ),
          ]),
        ),
      ]),
    );
  }
}

/// Number tiles, two to a row.
class StatsView extends StatelessWidget {
  const StatsView(this.tiles, {super.key});
  final List<StatTile> tiles;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return LayoutBuilder(builder: (_, box) {
      final w = (box.maxWidth - 8) / 2;
      return Wrap(spacing: 8, runSpacing: 8, children: [
        for (final s in tiles)
          Container(
            width: w,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: cs.surfaceContainerHighest.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(10)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _inline(s.label, t.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant)),
              const SizedBox(height: 2),
              _inline(s.value, t.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
              for (final n in s.notes) _inline(n, t.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
              if (s.bar != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: s.bar! / 100, minHeight: 5)),
                ),
            ]),
          ),
      ]);
    });
  }
}

class StepsView extends StatelessWidget {
  const StepsView(this.steps, {super.key});
  final List<PlanStep> steps;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final green = Hf.of(context).good;
    final red = cs.error;
    return Column(children: [
      for (final (i, s) in steps.indexed)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: switch (s.status) { 'done' => green, 'fail' => red, _ => null },
                border: Border.all(color: switch (s.status) { 'done' => green, 'fail' => red, 'next' || 'now' => cs.primary, _ => cs.outline }, width: 2),
              ),
              child: Text(
                switch (s.status) { 'done' => '✓', 'fail' => '✕', _ => '${i + 1}' },
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: s.status == 'done' || s.status == 'fail' ? Colors.white : null),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                _inline(s.title, t.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                if (s.detail.isNotEmpty) _inline(s.detail, t.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
              ]),
            ),
            const SizedBox(width: 6),
            Text(
              switch (s.status) { 'done' => 'Done', 'next' => 'Next', 'now' => 'Now', 'fail' => 'Failed', _ => 'To do' },
              style: t.textTheme.labelSmall?.copyWith(color: switch (s.status) { 'done' => green, 'fail' => red, 'next' || 'now' => cs.primary, _ => cs.onSurfaceVariant }),
            ),
          ]),
        ),
    ]);
  }
}

/// Option cards stacked, the recommended one marked.
class OptionsView extends StatelessWidget {
  const OptionsView(this.options, {super.key});
  final List<OptionCard> options;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return Column(children: [
      for (final o in options)
        Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: o.best ? cs.primary : cs.outlineVariant, width: o.best ? 2 : 1),
            color: o.best ? cs.primary.withValues(alpha: 0.05) : null,
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              if (o.key.isNotEmpty) ...[
                CircleAvatar(radius: 12, backgroundColor: o.best ? cs.primary : cs.surfaceContainerHighest, child: Text(o.key, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: o.best ? cs.onPrimary : cs.onSurface))),
                const SizedBox(width: 8),
              ],
              Expanded(child: _inline(o.title, t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600))),
              if (o.best)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(color: cs.primary, borderRadius: BorderRadius.circular(6)),
                  child: Text('RECOMMENDED', style: t.textTheme.labelSmall?.copyWith(color: cs.onPrimary, fontWeight: FontWeight.w700, fontSize: 9)),
                ),
            ]),
            for (final (pro, text) in o.points)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(pro ? '+ ' : '− ', style: TextStyle(fontWeight: FontWeight.w700, color: pro ? Hf.of(context).good : cs.error)),
                  Expanded(child: _inline(text, t.textTheme.bodySmall)),
                ]),
              ),
            if (o.effort > 0)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Row(children: [
                  Text('Effort ', style: t.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
                  for (var i = 1; i <= 3; i++)
                    Container(
                      width: 18,
                      height: 6,
                      margin: const EdgeInsets.only(left: 3),
                      decoration: BoxDecoration(color: i <= o.effort ? cs.primary : cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(3)),
                    ),
                ]),
              ),
          ]),
        ),
    ]);
  }
}

class DesignView extends StatelessWidget {
  const DesignView(this.cards, {super.key});
  final List<DesignCard> cards;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return Column(children: [
      for (final d in cards)
        Card(
          margin: const EdgeInsets.symmetric(vertical: 4),
          child: ListTile(
            leading: Icon(Icons.diamond_outlined, color: cs.primary),
            title: _inline(d.title, t.textTheme.titleSmall),
            subtitle: d.note.isEmpty ? null : _inline(d.note, t.textTheme.bodySmall),
            trailing: d.url == null ? null : const Icon(Icons.open_in_new),
            onTap: d.url == null ? null : () => openLink(d.url),
          ),
        ),
    ]);
  }
}

/// An overview grid, two to a row. A tile opens its own section on a page of its own,
/// or (no section in the answer) asks the session for more.
class TilesView extends StatelessWidget {
  const TilesView(this.tiles, {super.key, this.onChoice});
  final List<TileCard> tiles;
  final ValueChanged<String>? onChoice;

  void _open(BuildContext context, TileCard tile) {
    final detail = tile.detail;
    if (detail == null) {
      onChoice?.call('Tell me more about ${plain(tile.title)}');
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => DetailPage(doc: DetailDoc.parse(detail), title: tile.title, markdown: detail, onChoice: onChoice)));
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return LayoutBuilder(builder: (_, box) {
      final w = (box.maxWidth - 8) / 2;
      return Wrap(spacing: 8, runSpacing: 8, children: [
        for (final tile in tiles)
          SizedBox(
            width: w,
            child: Material(
              color: cs.surfaceContainerHighest.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(12),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: tile.detail == null && onChoice == null ? null : () => _open(context, tile),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (tile.picture != null)
                    AspectRatio(
                      aspectRatio: 16 / 9,
                      child: Image.network(tile.picture!, fit: BoxFit.cover, errorBuilder: (_, _, _) => ColoredBox(color: cs.surfaceContainerHighest)),
                    ),
                  Padding(
                    padding: const EdgeInsets.all(10),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      _inline(tile.title, t.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600), maxLines: 3),
                      if (tile.note.isNotEmpty)
                        Padding(padding: const EdgeInsets.only(top: 2), child: _inline(tile.note, t.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant), maxLines: 4)),
                    ]),
                  ),
                ]),
              ),
            ),
          ),
      ]);
    });
  }
}
