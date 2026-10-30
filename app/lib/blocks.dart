// Visual blocks in Claude's detail answers (the same format the web page draws in
// daemon/public/blocks.js), parsed into segments the phone lays out its own way:
//   ```stats  ```steps  ```options  ```design  ```wireframe  ```tiles   drawn natively
//   ```mermaid   drawn by mermaid in a web view (diagram_view.dart)
//   > [!TLDR] / [!NOTE] / [!TIP] / [!WARNING] / [!DECIDE]   callout boxes
// Anything else stays markdown, so a block the phone can't draw still shows as text
// and nothing is lost.

sealed class Segment {}

class MarkdownSeg extends Segment {
  MarkdownSeg(this.text);
  final String text;
}

class CalloutSeg extends Segment {
  CalloutSeg(this.kind, this.body, this.choices);

  /// tldr, note, tip, warning or decide
  final String kind;
  final String body;

  /// DECIDE: the possible answers (its list items)
  final List<String> choices;
}

class StatTile {
  StatTile(this.label, this.value, this.notes, this.bar);
  final String label;
  final String value;
  final List<String> notes;
  final int? bar; // 0-100
}

class StatsSeg extends Segment {
  StatsSeg(this.tiles);
  final List<StatTile> tiles;
}

class PlanStep {
  PlanStep(this.status, this.title, this.detail);

  /// done, next, now, todo or fail
  final String status;
  final String title;
  final String detail;
}

class StepsSeg extends Segment {
  StepsSeg(this.steps);
  final List<PlanStep> steps;
}

class OptionCard {
  OptionCard(this.key, this.best, this.title, this.effort);
  final String key;
  final bool best;
  final String title;
  final int effort; // 0 (not given) to 3
  final points = <(bool pro, String text)>[];
}

class OptionsSeg extends Segment {
  OptionsSeg(this.options);
  final List<OptionCard> options;
}

class DesignCard {
  DesignCard(this.title, this.url, this.note);
  final String title;
  final String? url; // https only
  final String note;
}

class DesignSeg extends Segment {
  DesignSeg(this.cards);
  final List<DesignCard> cards;
}

class TileCard {
  TileCard(this.title, this.note, this.picture);
  final String title;
  final String note;
  final String? picture; // https only

  /// its own "### Title" section of the answer, opened on tap; null: the tap asks the session
  String? detail;
}

class TilesSeg extends Segment {
  TilesSeg(this.tiles);
  final List<TileCard> tiles;
}

class MermaidSeg extends Segment {
  MermaidSeg(this.source);
  final String source;
}

/// One wireframe element: "kind | label | ..." (button* = the main one).
class WireItem {
  WireItem(this.kind, this.main, this.args, this.known, this.line);
  final String kind;
  final bool main;
  final List<String> args;
  final bool known;
  final String line; // as written, for kinds the phone doesn't know
  int? note; // the number of its pinned note

  String get a => args.isNotEmpty ? args[0] : '';
  String get b => args.length > 1 ? args[1] : '';
}

class WireScreen {
  WireScreen(this.frame, this.title);
  final String frame; // phone, tablet or browser
  final String title;
  final body = <WireItem>[];
  final nav = <WireItem>[];
  final side = <WireItem>[];
  final fab = <WireItem>[];
}

class WireframeSeg extends Segment {
  WireframeSeg(this.screens, this.notes);
  final List<WireScreen> screens;
  final List<String> notes;
}

List<String> _cells(String line) => line.split('|').map((s) => s.trim()).toList();
List<String> _lines(String src) => src.split('\n').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();

StatsSeg parseStats(String src) => StatsSeg([
      for (final line in _lines(src))
        () {
          final c = _cells(line);
          int? bar;
          final notes = <String>[];
          for (final r in c.skip(2)) {
            final m = RegExp(r'^bar:\s*(\d{1,3})%?$').firstMatch(r);
            if (m != null) {
              bar = int.parse(m[1]!).clamp(0, 100);
            } else if (r.isNotEmpty) {
              notes.add(r);
            }
          }
          return StatTile(c[0], c.length > 1 ? c[1] : '', notes, bar);
        }(),
    ]);

const stepStatuses = {'done', 'next', 'now', 'todo', 'fail'};

StepsSeg parseSteps(String src) => StepsSeg([
      for (final line in _lines(src))
        () {
          final c = _cells(line);
          final status = c[0].toLowerCase();
          if (!stepStatuses.contains(status)) return PlanStep('todo', c[0], c.length > 1 ? c[1] : '');
          return PlanStep(status, c.length > 1 ? c[1] : '', c.length > 2 ? c[2] : '');
        }(),
    ]);

OptionsSeg parseOptions(String src) {
  final cards = <OptionCard>[];
  for (final line in _lines(src)) {
    final point = RegExp(r'^([+-])\s+(.*)$').firstMatch(line);
    if (point != null && cards.isNotEmpty) {
      cards.last.points.add((point[1] == '+', point[2]!));
      continue;
    }
    final c = _cells(line);
    final m = RegExp(r'^(\S{1,3}?)(\*)?\s+(.+)$').firstMatch(c[0]);
    final effort = c.skip(1).map((r) => RegExp(r'^effort\s*(\d)$', caseSensitive: false).firstMatch(r)).whereType<RegExpMatch>().firstOrNull;
    cards.add(OptionCard(m?[1] ?? '', m?[2] != null, m?[3] ?? c[0], effort == null ? 0 : int.parse(effort[1]!).clamp(0, 3)));
  }
  return OptionsSeg(cards);
}

DesignSeg parseDesign(String src) => DesignSeg([
      for (final line in _lines(src))
        () {
          final c = _cells(line);
          final url = c.length > 1 && RegExp(r'''^https://[^\s"'<>]+$''').hasMatch(c[1]) ? c[1] : null;
          return DesignCard(c[0], url, c.length > 2 ? c[2] : '');
        }(),
    ]);

final _picture = RegExp(r'''^https://[^\s"'<>]+$''');

TilesSeg parseTiles(String src) => TilesSeg([
      for (final line in _lines(src))
        () {
          final c = _cells(line);
          final pic = c.skip(1).where(_picture.hasMatch).firstOrNull;
          return TileCard(c[0], c.skip(1).where((r) => r != pic && r.isNotEmpty).join(' · '), pic);
        }(),
    ]);

/// "🏛️ **AI Governance** Bill" and "AI governance bill" are the same tile.
String tileKey(String title) => title.toLowerCase().replaceAll(RegExp(r'[^\p{L}\p{N}]+', unicode: true), ' ').trim();

final _fenceOpen = RegExp(r'^\s*(`{3,}|~{3,})\s*([\w-]*)');
bool _closes(String line, String fence) => line.trim().startsWith(fence) && line.trim().replaceAll(fence[0], '').isEmpty;

/// Takes each tile's "### Title" section out of the answer (as the web page does in blocks.js).
/// A section runs to the next heading of level 1 to 3, or a --- line.
(String, Map<String, String>) splitTileDetails(String markdown) {
  final src = markdown.replaceAll('\r\n', '\n').split('\n');
  final keys = <String>{};
  String? fence;
  for (var i = 0; i < src.length; i++) {
    final f = _fenceOpen.firstMatch(src[i]);
    if (fence != null) {
      if (_closes(src[i], fence)) fence = null;
      continue;
    }
    if (f == null) continue;
    fence = f[1]!;
    if (f[2]!.toLowerCase() != 'tiles') continue;
    for (var j = i + 1; j < src.length && !src[j].trim().startsWith(fence); j++) {
      if (src[j].trim().isNotEmpty) keys.add(tileKey(_cells(src[j])[0]));
    }
  }
  if (keys.isEmpty) return (markdown, const {});
  final main = <String>[];
  final details = <String, List<String>>{};
  String? into;
  fence = null;
  for (final line in src) {
    final f = _fenceOpen.firstMatch(line);
    if (fence != null) {
      if (_closes(line, fence)) fence = null;
    } else if (f != null) {
      fence = f[1]!;
    } else {
      final h = RegExp(r'^(#{1,3})\s+(.+)$').firstMatch(line);
      if (h != null || RegExp(r'^\s*(-{3,}|\*{3,}|_{3,})\s*$').hasMatch(line)) {
        final key = h != null && h[1]!.length == 3 ? tileKey(h[2]!) : null;
        into = key != null && keys.contains(key) && !details.containsKey(key) ? key : null;
        if (into != null) {
          details[into] = [];
          continue;
        }
      }
    }
    (into != null ? details[into]! : main).add(line);
  }
  return (main.join('\n'), {for (final e in details.entries) e.key: e.value.join('\n').trim()});
}

const wireFrames = {'phone', 'browser', 'tablet'};
const wireKinds = {'bar', 'header', 'title', 'text', 'input', 'search', 'select', 'button', 'link', 'image', 'card', 'list', 'tabs',
    'chips', 'nav', 'sidebar', 'toggle', 'check', 'radio', 'divider', 'space', 'avatar', 'grid', 'table', 'fab', 'row'};

/// "*Active*" marks the selected tab, chip or control.
bool starred(String s) => RegExp(r'^\*|\*$').hasMatch(s);
String unstar(String s) => s.replaceAll(RegExp(r'^\*\s*|\s*\*$'), '');

/// One line of a wireframe; also each cell of a "row".
WireItem wireLine(String line) {
  final parts = _cells(line);
  var head = parts.removeAt(0);
  String kindOf(String h) => h.replaceAll('*', '').toLowerCase();
  final word = RegExp(r'^(\w+\*?)\s+(.+)$').firstMatch(head);
  if (word != null && (wireKinds.contains(kindOf(word[1]!)) || wireFrames.contains(kindOf(word[1]!)))) {
    head = word[1]!;
    parts.insert(0, word[2]!);
  }
  head = head.toLowerCase();
  final kind = head.replaceAll('*', '');
  return WireItem(kind, head.endsWith('*'), parts, wireKinds.contains(kind) || wireFrames.contains(kind), line);
}

WireframeSeg parseWireframe(String src) {
  final screens = <WireScreen>[];
  final notes = <String>[];
  for (final line in _lines(src)) {
    final item = wireLine(line);
    if (wireFrames.contains(item.kind)) {
      screens.add(WireScreen(item.kind, item.a));
      continue;
    }
    if (screens.isEmpty) screens.add(WireScreen('phone', ''));
    final s = screens.last;
    final note = item.args.indexWhere((t) => RegExp(r'^note:', caseSensitive: false).hasMatch(t));
    if (note >= 0) {
      notes.add(item.args.removeAt(note).replaceFirst(RegExp(r'^note:\s*', caseSensitive: false), ''));
      item.note = notes.length;
    }
    (switch (item.kind) { 'nav' => s.nav, 'sidebar' => s.side, 'fab' => s.fab, _ => s.body }).add(item);
  }
  return WireframeSeg(screens, notes);
}

const _drawn = {
  'stats': parseStats,
  'steps': parseSteps,
  'options': parseOptions,
  'design': parseDesign,
  'wireframe': parseWireframe,
  'tiles': parseTiles,
  'mermaid': MermaidSeg.new,
};

const calloutKinds = {'tldr': 'tldr', 'note': 'note', 'tip': 'tip', 'warning': 'warning', 'caution': 'warning', 'decide': 'decide'};

CalloutSeg? _callout(List<String> quoted) {
  final m = RegExp(r'^\[!(\w+)\]\s*', caseSensitive: false).firstMatch(quoted.first);
  final kind = m == null ? null : calloutKinds[m[1]!.toLowerCase()];
  if (kind == null) return null;
  final lines = [quoted.first.substring(m!.end), ...quoted.skip(1)];
  final choices = <String>[];
  if (kind == 'decide') {
    lines.removeWhere((l) {
      final item = RegExp(r'^\s*(?:[-*+]|\d+\.)\s+(.*)$').firstMatch(l);
      if (item != null) choices.add(item[1]!.trim());
      return item != null;
    });
  }
  return CalloutSeg(kind, lines.join('\n').trim(), choices);
}

/// A detail answer split into what the phone draws itself and plain markdown.
class DetailDoc {
  DetailDoc(this.segments);
  final List<Segment> segments;

  factory DetailDoc.parse(String answer) {
    final (markdown, details) = splitTileDetails(answer);
    final out = <Segment>[];
    final md = <String>[];
    void flush() {
      final text = md.join('\n').trim();
      if (text.isNotEmpty) out.add(MarkdownSeg(text));
      md.clear();
    }

    final lines = markdown.replaceAll('\r\n', '\n').split('\n');
    var i = 0;
    while (i < lines.length) {
      final line = lines[i];
      final fence = RegExp(r'^\s*(`{3,}|~{3,})\s*([\w-]*)').firstMatch(line);
      if (fence != null) {
        final marker = fence[1]!;
        final end = lines.indexWhere((l) => l.trim().startsWith(marker[0] * marker.length) && l.trim().replaceAll(marker[0], '').isEmpty, i + 1);
        final close = end < 0 ? lines.length : end;
        final parse = _drawn[fence[2]!.toLowerCase()];
        if (parse != null) {
          flush();
          out.add(parse(lines.sublist(i + 1, close).join('\n')));
        } else {
          md.addAll(lines.sublist(i, end < 0 ? lines.length : end + 1)); // drawn as code
        }
        i = close + 1;
        continue;
      }
      if (line.trimLeft().startsWith('>')) {
        var j = i;
        final quoted = <String>[];
        while (j < lines.length && lines[j].trimLeft().startsWith('>')) {
          quoted.add(lines[j].trimLeft().replaceFirst(RegExp(r'^>\s?'), ''));
          j++;
        }
        final callout = _callout(quoted);
        if (callout != null) {
          flush();
          out.add(callout);
        } else {
          md.addAll(lines.sublist(i, j));
        }
        i = j;
        continue;
      }
      md.add(line);
      i++;
    }
    flush();
    for (final t in out.whereType<TilesSeg>().expand((s) => s.tiles)) {
      t.detail = details[tileKey(t.title)];
    }
    return DetailDoc(out);
  }

  /// The first heading, for the summary card.
  String? get title {
    for (final s in segments.whereType<MarkdownSeg>()) {
      final m = RegExp(r'^#{1,3}\s+(.+)$', multiLine: true).firstMatch(s.text);
      if (m != null) return m[1]!.trim();
    }
    return null;
  }

  /// The "in short" line, for the summary card.
  String? get tldr => segments.whereType<CalloutSeg>().where((c) => c.kind == 'tldr' || c.kind == 'note').firstOrNull?.body;

  /// Warnings and decisions show even on the summary card, so nothing crucial hides behind a tap.
  List<CalloutSeg> get mustSee => segments.whereType<CalloutSeg>().where((c) => c.kind == 'warning' || c.kind == 'decide').toList();

  /// Short words for what's inside, like "4 numbers" or "diagram".
  List<String> get contents {
    final out = <String>[];
    for (final s in segments) {
      switch (s) {
        case StatsSeg(:final tiles):
          out.add('${tiles.length} number${tiles.length == 1 ? '' : 's'}');
        case StepsSeg(:final steps):
          out.add('${steps.length} step${steps.length == 1 ? '' : 's'}');
        case OptionsSeg(:final options):
          out.add('${options.length} option${options.length == 1 ? '' : 's'}');
        case DesignSeg():
          out.add('design');
        case TilesSeg(:final tiles):
          out.add('${tiles.length} tile${tiles.length == 1 ? '' : 's'}');
        case MermaidSeg():
          out.add('diagram');
        case WireframeSeg(:final screens):
          out.add(screens.length == 1 ? 'wireframe' : '${screens.length} screens');
        case MarkdownSeg(:final text):
          if (RegExp(r'^\s*\|?\s*:?-{3,}', multiLine: true).hasMatch(text)) out.add('table');
        case CalloutSeg():
          break;
      }
    }
    return out;
  }

  /// Plain short text with nothing to lay out: shown in the chat as is.
  bool get isSimple => segments.length == 1 && segments.first is MarkdownSeg && contents.isEmpty && (segments.first as MarkdownSeg).text.length < 400;
}
