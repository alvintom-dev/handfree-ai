import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'detail_view.dart' show copyText;

// ```mermaid diagrams, drawn by the same library as the web page inside a web view
// (assets/diagram). Only the full answer page makes one, never the chat list.
// Left-to-right flowcharts stand upright on the phone, so they fit a narrow screen.

class DiagramView extends StatefulWidget {
  const DiagramView(this.source, {super.key});
  final String source;

  @override
  State<DiagramView> createState() => _DiagramViewState();
}

class _DiagramViewState extends State<DiagramView> {
  static const _maxHeight = 900.0; // the page scrolls; taller ones open full screen
  double? _height;
  String? _error;

  void _open() => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DiagramPage(source: widget.source)));

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    // no web view (tests) or a diagram mermaid can't draw: the source, so nothing is lost
    if (WebViewPlatform.instance == null || _error != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_error != null) Text('Diagram could not be drawn ($_error):', style: t.textTheme.bodySmall?.copyWith(color: cs.error)),
        _Source(widget.source),
      ]);
    }
    final h = _height;
    return Material(
      color: cs.surfaceContainerLow,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: cs.outlineVariant)),
      clipBehavior: Clip.antiAlias,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque, // the web view itself ignores touches
        onTap: _open,
        child: Stack(children: [
          AnimatedSize(
            duration: const Duration(milliseconds: 150),
            child: SizedBox(
              height: h == null ? 160 : h.clamp(60, _maxHeight),
              child: IgnorePointer(
                child: DiagramWeb(
                  source: widget.source,
                  onHeight: (v) => setState(() => _height = v),
                  onError: (e) => setState(() => _error = e),
                ),
              ),
            ),
          ),
          if (h == null) const Positioned.fill(child: Center(child: CircularProgressIndicator(strokeWidth: 2))),
          Positioned(
            right: 6,
            bottom: 6,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: cs.surface.withValues(alpha: 0.9), borderRadius: BorderRadius.circular(10), border: Border.all(color: cs.outlineVariant)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.zoom_out_map, size: 13, color: cs.primary),
                const SizedBox(width: 4),
                Text(h != null && h > _maxHeight ? 'Tap to see all' : 'Tap to zoom', style: t.textTheme.labelSmall?.copyWith(color: cs.primary)),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}

/// The diagram full screen: pinch to zoom, drag to move, and turn it either way.
class DiagramPage extends StatefulWidget {
  const DiagramPage({super.key, required this.source});
  final String source;

  @override
  State<DiagramPage> createState() => _DiagramPageState();
}

class _DiagramPageState extends State<DiagramPage> {
  var _upright = true;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final flow = RegExp(r'^\s*(flowchart|graph)\s+(LR|RL)\b').hasMatch(widget.source);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Diagram'),
        actions: [
          if (flow)
            IconButton(
              onPressed: () => setState(() => _upright = !_upright),
              icon: Icon(_upright ? Icons.swap_horiz : Icons.swap_vert),
              tooltip: _upright ? 'Left to right, as written' : 'Top to bottom',
            ),
          Builder(builder: (context) => IconButton(onPressed: () => copyText(context, widget.source, what: 'Diagram source copied'), icon: const Icon(Icons.copy), tooltip: 'Copy the diagram source')),
        ],
      ),
      body: SafeArea(
        child: _error != null
            ? ListView(padding: const EdgeInsets.all(16), children: [Text('Diagram could not be drawn ($_error):'), const SizedBox(height: 8), _Source(widget.source)])
            : DiagramWeb(key: ValueKey(_upright), source: widget.source, upright: _upright, zoom: true, onError: (e) => setState(() => _error = e)),
      ),
    );
  }
}

/// The web view itself. Reports the drawn height, or why mermaid failed.
class DiagramWeb extends StatefulWidget {
  const DiagramWeb({super.key, required this.source, this.upright = true, this.zoom = false, this.onHeight, this.onError});
  final String source;
  final bool upright;
  final bool zoom;
  final ValueChanged<double>? onHeight;
  final ValueChanged<String>? onError;

  @override
  State<DiagramWeb> createState() => _DiagramWebState();
}

class _DiagramWebState extends State<DiagramWeb> {
  late final WebViewController _web;
  Timer? _timeout;
  var _started = false;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..enableZoom(widget.zoom)
      ..addJavaScriptChannel('Handfree', onMessageReceived: (m) {
        _timeout?.cancel();
        final msg = jsonDecode(m.message) as Map<String, dynamic>;
        if (!mounted) return;
        if (msg['error'] != null) {
          widget.onError?.call(msg['error'] as String);
        } else {
          widget.onHeight?.call((msg['height'] as num).toDouble());
        }
      })
      ..setNavigationDelegate(NavigationDelegate(
        // only the bundled page itself; a diagram can't send the view anywhere else
        onNavigationRequest: (r) => r.url.startsWith('file:') ? NavigationDecision.navigate : NavigationDecision.prevent,
        onPageFinished: (_) => _draw(),
      ))
      ..loadFlutterAsset('assets/diagram/diagram.html');
    _timeout = Timer(const Duration(seconds: 15), () => widget.onError?.call('timed out'));
  }

  void _draw() {
    if (_started || !mounted) return;
    _started = true;
    final dark = Theme.of(context).brightness == Brightness.dark;
    _web.runJavaScript('draw(${jsonEncode(widget.source)}, $dark, ${widget.upright})');
  }

  @override
  void dispose() {
    _timeout?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _web);
}

class _Source extends StatelessWidget {
  const _Source(this.source);
  final String source;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(color: cs.surfaceContainerHighest.withValues(alpha: 0.6), borderRadius: BorderRadius.circular(8)),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.all(10),
        child: SelectableText(source, style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5)),
      ),
    );
  }
}
