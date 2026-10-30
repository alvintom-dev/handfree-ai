import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:handfree/blocks.dart';
import 'package:handfree/detail_view.dart';

const sample = '''## Phone app: suggested tasks
> [!TLDR] The **detail view** is the biggest gap.

```stats
Paired phones | 2 | Xiaomi + emulator
Daemon tests | 42 / 42 | all green | bar:100
```

```steps
done | Pair | QR scanned
next | Push-to-talk | speak from the phone
todo | Done tone
fail | Old build | crashed
```

```options
A* Visual blocks first | effort 3
+ biggest visible gain
- most work
B Quick wins | effort 1
+ one sitting
```

```design
Login screen | https://claude.ai/code/artifact/abc | polished version
```

| Block | Hard? |
|---|---|
| stats | easy |

```mermaid
flowchart LR
  A --> B
```

```wireframe
phone | Login
bar | Sign in
input | Email | note: autofocus
button* | Continue
row | button Cancel | button* OK
nav | *Home* | Profile
phone | Done
sparkle | Unknown kind
```

> [!WARNING] Bundling mermaid adds about 3 MB.

> [!DECIDE] Where do we start?
> - A. Visual blocks
> - B. Quick wins

> a plain quote stays a quote
''';

void main() {
  test('blocks and callouts become segments; everything else stays markdown', () {
    final doc = DetailDoc.parse(sample);
    expect(doc.title, 'Phone app: suggested tasks');
    expect(doc.tldr, 'The **detail view** is the biggest gap.');
    final stats = doc.segments.whereType<StatsSeg>().single;
    expect(stats.tiles[1].value, '42 / 42');
    expect(stats.tiles[1].bar, 100);
    expect(stats.tiles[1].notes, ['all green']);
    final steps = doc.segments.whereType<StepsSeg>().single.steps;
    expect(steps.map((s) => s.status), ['done', 'next', 'todo', 'fail']);
    final options = doc.segments.whereType<OptionsSeg>().single.options;
    expect((options[0].key, options[0].best, options[0].effort, options[0].points.length), ('A', true, 3, 2));
    expect(options[1].best, isFalse);
    expect(doc.segments.whereType<DesignSeg>().single.cards.single.url, 'https://claude.ai/code/artifact/abc');
    final decide = doc.mustSee.firstWhere((c) => c.kind == 'decide');
    expect(decide.choices, ['A. Visual blocks', 'B. Quick wins']);
    expect(decide.body, 'Where do we start?');
    expect(doc.mustSee.map((c) => c.kind), ['warning', 'decide']);
    expect(doc.segments.whereType<MermaidSeg>().single.source, 'flowchart LR\n  A --> B');
    final wire = doc.segments.whereType<WireframeSeg>().single;
    expect(wire.screens.map((s) => s.title), ['Login', 'Done']);
    final login = wire.screens.first;
    expect(login.body.map((e) => e.kind), ['bar', 'input', 'button', 'row']);
    expect((login.body[1].note, login.body[2].main), (1, true));
    expect(wire.notes, ['autofocus']);
    expect(login.nav.single.args, ['*Home*', 'Profile']);
    expect(wire.screens.last.body.single.known, isFalse);
    final md = doc.segments.whereType<MarkdownSeg>().map((s) => s.text).join('\n');
    expect(md, contains('> a plain quote stays a quote'));
    expect(doc.contents, containsAll(['2 numbers', '4 steps', '2 options', 'design', 'table', 'diagram', '2 screens']));
    expect(doc.isSimple, isFalse);
    expect(DetailDoc.parse('Just a short answer.').isSimple, isTrue);
  });

  test('an unknown callout type and an unclosed fence are kept as text', () {
    final doc = DetailDoc.parse('> [!SHOUT] hey\n\n```stats\nA | 1');
    expect(doc.segments.first, isA<MarkdownSeg>());
    expect(doc.segments.whereType<StatsSeg>().single.tiles.single.value, '1');
  });

  testWidgets('the full page shows every piece of text in the answer', (tester) async {
    final doc = DetailDoc.parse(sample);
    await tester.pumpWidget(MaterialApp(home: DetailPage(doc: doc, title: doc.title!)));
    final page = find.byType(Scrollable).first;
    for (final words in [
      'detail view', 'Paired phones', 'Xiaomi + emulator', '42 / 42', 'all green', 'QR scanned', 'Push-to-talk', 'Done tone',
      'Old build', 'Visual blocks first', 'biggest visible gain', 'most work', 'one sitting', 'RECOMMENDED', 'Login screen',
      'polished version', 'flowchart LR', 'Sign in', 'Email', 'autofocus', 'Continue', 'Cancel', 'OK', 'Home', 'Profile',
      'sparkle | Unknown kind', 'Bundling mermaid', 'Where do we start?', 'A. Visual blocks', 'B. Quick wins',
      'a plain quote stays a quote',
    ]) {
      final f = find.textContaining(words, findRichText: true);
      await tester.scrollUntilVisible(f, 200, scrollable: page);
      expect(f, findsWidgets, reason: words);
    }
  });

  testWidgets('the chat card shows the title, the short version, warnings and decisions', (tester) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child: DetailCard(markdown: sample, label: 'Detail')))));
    expect(find.text('Phone app: suggested tasks'), findsOneWidget);
    expect(find.textContaining('biggest gap', findRichText: true), findsOneWidget);
    expect(find.textContaining('Bundling mermaid', findRichText: true), findsOneWidget);
    expect(find.textContaining('B. Quick wins', findRichText: true), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.byType(DetailPage), findsOneWidget);
  });

  testWidgets('a code block copies just its code', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String;
      return null;
    });
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DetailCard(markdown: 'Run this:\n\n```sh\ngit push origin main\n```', label: 'Detail'))));
    await tester.tap(find.byTooltip('Copy code'));
    expect(copied, 'git push origin main');
    await tester.tap(find.byTooltip('Copy the answer'));
    expect(copied, contains('Run this:'));
  });

  test('tiles take their own sections out of the answer', () {
    const md = '## Overview\n```tiles\n🏛️ **AI Governance Bill** | 9 articles | https://e.com/a.jpg\nPRN Melaka | 6\n```\n'
        '### AI governance bill\nDelayed.\n```mermaid\npie\n### inside a fence\n```\n---\n## After\nkept';
    final doc = DetailDoc.parse(md);
    final tiles = doc.segments.whereType<TilesSeg>().single.tiles;
    expect(tiles[0].picture, 'https://e.com/a.jpg');
    expect(tiles[0].note, '9 articles');
    expect(tiles[0].detail, 'Delayed.\n```mermaid\npie\n### inside a fence\n```');
    expect(tiles[1].detail, isNull); // no section: the tap asks the session
    final text = doc.segments.whereType<MarkdownSeg>().map((s) => s.text).join('\n');
    expect(text, isNot(contains('Delayed')));
    expect(text, contains('## After'));
    expect(doc.contents, contains('2 tiles'));
  });

  testWidgets('a tile opens its section, or asks the session', (tester) async {
    String? asked;
    const md = '## Overview\n```tiles\nPRN Melaka | 6\nSpain crash | 7\n```\n### PRN Melaka\nPolling 14 Nov';
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: DetailCard(markdown: md, label: 'Detail', onChoice: (v) => asked = v))));
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('PRN Melaka'));
    await tester.pumpAndSettle();
    expect(find.text('Polling 14 Nov'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Spain crash'));
    await tester.pumpAndSettle();
    expect(asked, 'Tell me more about Spain crash');
    expect(find.byType(DetailPage), findsNothing); // back in the chat to hear it
  });
}
