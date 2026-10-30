import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import 'blocks.dart';
import 'controller.dart';
import 'detail_view.dart';
import 'new_session.dart';
import 'pairing.dart';
import 'settings_screen.dart';
import 'theme.dart';

// The phone chat, laid out like the web dashboard's chat view: sessions in a
// sidebar, the conversation, and the voice bar at the bottom.

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.info, required this.store, required this.onUnpair});
  final PairInfo info;
  final PairStore store;
  final VoidCallback onUnpair;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final AppController c;
  final input = TextEditingController();
  final scroll = ScrollController();
  bool _atBottom = true;
  int _seenCount = 0;
  int _newCount = 0;
  String? _seenSession;
  bool _bannerClosed = false;

  @override
  void initState() {
    super.initState();
    c = AppController(widget.info, widget.store)..start();
    c.addListener(_changed);
    scroll.addListener(_scrolled);
  }

  void _scrolled() {
    if (!scroll.hasClients) return;
    final at = scroll.position.pixels >= scroll.position.maxScrollExtent - 48;
    if (at != _atBottom) setState(() => _atBottom = at);
    if (at && _newCount > 0) setState(() => _newCount = 0);
  }

  void _changed() {
    if (c.link == 'unauthorized') {
      WidgetsBinding.instance.addPostFrameCallback((_) => _askRepair());
    }
    final count = c.visibleItems.length;
    final switched = c.activeSession != _seenSession;
    // stay put while you read further up; count what arrives below instead
    if (!switched && !_atBottom && count > _seenCount) _newCount += count - _seenCount;
    _seenCount = count;
    _seenSession = c.activeSession;
    setState(() {});
    if (_atBottom || switched) _toBottom(animate: !switched);
  }

  void _toBottom({bool animate = true}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!scroll.hasClients) return;
      final end = scroll.position.maxScrollExtent;
      animate ? scroll.animateTo(end, duration: const Duration(milliseconds: 250), curve: Curves.easeOut) : scroll.jumpTo(end);
    });
  }

  bool _asked = false;
  Future<void> _askRepair() async {
    if (_asked || !mounted) return;
    _asked = true;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Pairing no longer valid'),
        content: const Text('This phone was unpaired on the Mac, or its pairing code was already used. Pair again.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Pair again'))],
      ),
    );
    widget.onUnpair();
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    c.dispose();
    scroll.dispose();
    super.dispose();
  }

  void _openSettings() => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => SettingsScreen(c: c, onUnpair: widget.onUnpair)));
  void _openNew() => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => NewSessionScreen(c: c)));

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final s = c.activeSessionInfo;
    final st = s == null ? null : c.statusOf(s['key'] as String);
    final shown = c.visibleItems;
    return Scaffold(
      drawer: SessionsDrawer(c: c, onNew: _openNew, onSettings: _openSettings),
      appBar: AppBar(
        titleSpacing: 0,
        leading: Builder(builder: (ctx) => IconButton(tooltip: 'Sessions', icon: const Icon(Icons.menu), onPressed: () => Scaffold.of(ctx).openDrawer())),
        title: Builder(
          builder: (ctx) => InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => Scaffold.of(ctx).openDrawer(),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
              child: Row(children: [
                StatusDot(kind: st?.kind ?? 'idle'),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(s?['label'] as String? ?? 'No Claude session', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: h.fg)),
                    Text(
                      c.link != 'online' ? (c.link == 'connecting' ? 'Connecting…' : 'Reconnecting to ${widget.info.name}…') : st == null ? 'Start one from the sidebar' : _statusLine(st),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w400, color: c.link != 'online' ? h.bad : statusColor(h, st?.kind ?? 'idle')),
                    ),
                  ]),
                ),
              ]),
            ),
          ),
        ),
        actions: [
          _SquareButton(
            tooltip: c.muted ? 'Unmute Claude on this phone' : 'Mute Claude on this phone',
            icon: c.muted ? Icons.volume_off_outlined : Icons.volume_up_outlined,
            onPressed: () => c.setMuted(!c.muted),
          ),
          PopupMenuButton<String>(
            tooltip: 'Session menu',
            onSelected: (v) {
              if (v == 'voice_off') c.stopVoice();
              if (v == 'end') _confirmEnd(context, c);
              if (v == 'rename') _rename(context, c);
              if (v == 'settings') _openSettings();
            },
            itemBuilder: (_) => [
              if (s?['can_end'] == true) PopupMenuItem(value: 'rename', child: Text('Rename ${s!['label']}')),
              if (c.speech != 'off') const PopupMenuItem(value: 'voice_off', child: Text('Stop voice (frees Mac memory)')),
              const PopupMenuItem(value: 'settings', child: Text('Settings')),
              if (s?['can_end'] == true) PopupMenuItem(value: 'end', child: Text('End ${s!['label']}', style: TextStyle(color: h.bad))),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (c.fullDisk == false && !_bannerClosed)
            _Banner(
              text: 'The Mac may stop at a permission pop-up.',
              action: 'How to fix',
              onAction: () => showFullDiskHelp(context),
              onClose: () => setState(() => _bannerClosed = true),
            ),
          if (c.sessionPins.isNotEmpty) PinsBar(c: c),
          Expanded(
            child: Stack(children: [
              ListView.builder(
                controller: scroll,
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
                itemCount: shown.length + 1,
                itemBuilder: (_, i) => i < shown.length ? _ItemView(item: shown[i], controller: c) : ActivityRow(c: c),
              ),
              if (shown.isEmpty && c.link == 'online')
                Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      s == null ? 'No Claude session yet.\nOpen the sidebar and tap New session.' : 'Talk or type to ${s['label']}.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: h.muted),
                    ),
                  ),
                ),
              if (!_atBottom && _newCount > 0)
                Positioned(
                  bottom: 14,
                  left: 0,
                  right: 0,
                  child: Center(
                    child: FilledButton.icon(
                      style: FilledButton.styleFrom(shape: const StadiumBorder(), minimumSize: const Size(0, 48), padding: const EdgeInsets.symmetric(horizontal: 22)),
                      onPressed: () {
                        setState(() => _newCount = 0);
                        _toBottom();
                      },
                      icon: const Icon(Icons.arrow_downward, size: 18),
                      label: Text('$_newCount new'),
                    ),
                  ),
                ),
            ]),
          ),
          VoiceBar(c: c, input: input),
        ],
      ),
    );
  }
}

String _statusLine(SessionStatus st) => st.kind == 'working' ? 'Working · ${st.line}' : st.label;

Color statusColor(Hf h, String kind) => switch (kind) { 'needs' || 'ask' => h.warn, 'idle' => h.muted, _ => h.accent };

/// Green working, amber needs you, a grey ring when idle (as on the web).
class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.kind});
  final String kind;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final idle = kind == 'idle';
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: idle ? null : statusColor(h, kind),
        border: idle ? Border.all(color: h.idle, width: 2) : null,
      ),
    );
  }
}

class _SquareButton extends StatelessWidget {
  const _SquareButton({required this.tooltip, required this.icon, required this.onPressed});
  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        icon: Icon(icon, size: 20),
        style: IconButton.styleFrom(
          fixedSize: const Size(44, 44),
          backgroundColor: h.card,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: h.line)),
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, required this.action, required this.onAction, required this.onClose});
  final String text;
  final String action;
  final VoidCallback onAction;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Container(
      decoration: BoxDecoration(color: h.warnSoft, border: Border(bottom: BorderSide(color: h.line))),
      padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
      child: Row(children: [
        Expanded(child: Text(text, style: TextStyle(fontSize: 13.5, color: h.fg))),
        OutlinedButton(
          onPressed: onAction,
          style: OutlinedButton.styleFrom(foregroundColor: h.warn, backgroundColor: Colors.transparent, side: BorderSide(color: h.warn), minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 12)),
          child: Text(action, style: const TextStyle(fontSize: 13)),
        ),
        IconButton(onPressed: onClose, tooltip: 'Dismiss', icon: Icon(Icons.close, size: 18, color: h.muted)),
      ]),
    );
  }
}

// --- sidebar ---------------------------------------------------------------------------

/// Every session, grouped like the web's list: Needs you, Working, Idle.
class SessionsDrawer extends StatefulWidget {
  const SessionsDrawer({super.key, required this.c, required this.onNew, required this.onSettings});
  final AppController c;
  final VoidCallback onNew;
  final VoidCallback onSettings;

  @override
  State<SessionsDrawer> createState() => _SessionsDrawerState();
}

class _SessionsDrawerState extends State<SessionsDrawer> {
  String query = '';
  bool? idleOpen;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Drawer(
      width: 316,
      child: SafeArea(
        child: ListenableBuilder(
          listenable: widget.c,
          builder: (context, _) {
            final c = widget.c;
            final all = [
              for (final s in c.sessions)
                if (query.isEmpty || '${s['label']} ${s['project'] ?? ''}'.toLowerCase().contains(query.toLowerCase())) (s, c.statusOf(s['key'] as String)),
            ];
            const order = {'needs': 0, 'ask': 1, 'working': 2, 'speaking': 3, 'done': 4, 'idle': 5};
            all.sort((a, b) => order[a.$2.kind]!.compareTo(order[b.$2.kind]!));
            final open = idleOpen ?? (c.sessions.length <= 6 || query.isNotEmpty);
            final groups = [
              ('Needs you', h.warn, 'needs'),
              ('Working', h.accent, 'working'),
              ('Idle', h.muted, 'idle'),
            ];
            final mac = c.link == 'online' ? '${widget.c.info.name} · ${c.viaTailscale ? 'via Tailscale' : 'home network'}' : '${widget.c.info.name} · offline';
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 14, 6, 8),
                child: Row(children: [
                  Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(color: h.accent, borderRadius: BorderRadius.circular(9)),
                    child: Icon(Icons.mic_none, size: 18, color: h.onAccent),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Handfree', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: h.fg, height: 1.2)),
                      Text(mac, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: c.link == 'online' ? h.muted : h.bad)),
                    ]),
                  ),
                  IconButton(tooltip: 'Close sessions', onPressed: () => Navigator.pop(context), icon: Icon(Icons.close, color: h.muted)),
                ]),
              ),
              if (c.sessions.length > 6)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                  child: TextField(
                    onChanged: (v) => setState(() => query = v),
                    decoration: InputDecoration(
                      hintText: 'Find a session',
                      prefixIcon: Icon(Icons.search, size: 18, color: h.muted),
                      fillColor: h.bg,
                    ),
                  ),
                ),
              Expanded(
                child: ListView(padding: const EdgeInsets.fromLTRB(10, 0, 10, 8), children: [
                  if (c.sessions.isEmpty)
                    Padding(padding: const EdgeInsets.all(16), child: Text('No sessions running.', style: TextStyle(color: h.muted))),
                  for (final (title, color, group) in groups)
                    ...() {
                      final list = all.where((e) => e.$2.group == group).toList();
                      if (list.isEmpty) return <Widget>[];
                      final foldable = group == 'idle';
                      return [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(10, 12, 4, 4),
                          child: Row(children: [
                            Expanded(child: Text('${title.toUpperCase()} · ${list.length}', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.7, color: color))),
                            if (foldable)
                              TextButton(
                                style: TextButton.styleFrom(minimumSize: const Size(0, 32), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                onPressed: () => setState(() => idleOpen = !open),
                                child: Text(open ? 'Hide' : 'Show', style: const TextStyle(fontSize: 12)),
                              ),
                          ]),
                        ),
                        if (!foldable || open)
                          for (final (s, st) in list) _SessionRow(s: s, st: st, selected: s['key'] == c.activeSession, onTap: () {
                            c.selectSession(s['key'] as String);
                            Navigator.pop(context);
                          }),
                      ];
                    }(),
                ]),
              ),
              Container(
                decoration: BoxDecoration(border: Border(top: BorderSide(color: h.line))),
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  if (c.link == 'online')
                    FilledButton.icon(
                      style: FilledButton.styleFrom(minimumSize: const Size(0, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                      onPressed: () {
                        Navigator.pop(context);
                        widget.onNew();
                      },
                      icon: const Icon(Icons.add),
                      label: const Text('New session'),
                    ),
                  const SizedBox(height: 4),
                  TextButton.icon(
                    style: TextButton.styleFrom(foregroundColor: h.fg, alignment: Alignment.centerLeft, minimumSize: const Size(0, 44)),
                    onPressed: () {
                      Navigator.pop(context);
                      widget.onSettings();
                    },
                    icon: const Icon(Icons.settings_outlined, size: 20),
                    label: const Text('Settings', style: TextStyle(fontWeight: FontWeight.w400, fontSize: 15)),
                  ),
                ]),
              ),
            ]);
          },
        ),
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.s, required this.st, required this.selected, required this.onTap});
  final Map<String, dynamic> s;
  final SessionStatus st;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final label = s['label'] as String? ?? '';
    final project = s['project'] as String?;
    final sub = st.kind == 'working' || st.kind == 'needs' ? '${st.label} · ${st.line}' : st.label;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? h.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            decoration: selected ? BoxDecoration(border: Border(left: BorderSide(color: h.accent, width: 4))) : null,
            padding: EdgeInsets.fromLTRB(selected ? 6 : 10, 6, 10, 6),
            child: Row(children: [
              SizedBox(
                width: 24,
                child: selected
                    ? Container(
                        width: 24,
                        height: 24,
                        decoration: BoxDecoration(color: h.accent, shape: BoxShape.circle),
                        child: Icon(Icons.mic, size: 14, color: h.onAccent),
                      )
                    : Center(child: StatusDot(kind: st.kind)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, color: h.fg)),
                  if (project != null && project.isNotEmpty && !label.contains(project))
                    Text(project, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: h.muted)),
                  Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: statusColor(h, st.kind))),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

// --- chat ------------------------------------------------------------------------------

/// A web-style message card: white on the page colour, a coloured bar on the left.
class MsgCard extends StatelessWidget {
  const MsgCard({super.key, required this.child, this.edge, this.fill, this.border});
  final Widget child;
  final Color? edge;
  final Color? fill;
  final Color? border;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final body = Padding(padding: const EdgeInsets.fromLTRB(14, 10, 14, 12), child: child);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: fill ?? h.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: border ?? h.line, width: border == null ? 1 : 2),
      ),
      child: edge == null ? body : IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Container(width: 3, color: edge), Expanded(child: body)])),
    );
  }
}

class _ItemView extends StatelessWidget {
  const _ItemView({required this.item, required this.controller});
  final Item item;
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    Widget who(List<Widget> children) => Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(children: children),
        );
    TextStyle small([Color? c]) => TextStyle(fontSize: 12, color: c ?? h.muted);
    final at = item.meta['at'] as num?;
    final time = at == null ? '' : ' · ${_when(context, at.toInt())}';

    switch (item.kind) {
      case ItemKind.user:
        final voice = item.meta['via'] == 'voice';
        final tags = [
          voice ? 'You said' : 'You typed',
          if (item.meta['from'] != null) item.meta['from'],
          if (item.meta['interrupted_after'] != null) 'interrupted',
          if (item.meta['while_working'] != null) 'by the way',
        ].join(' · ') + time;
        return GestureDetector(
          onLongPress: () => copyText(context, item.text),
          child: MsgCard(
            edge: h.muted,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              who([Icon(voice ? Icons.mic_none : Icons.keyboard_outlined, size: 14, color: h.muted), const SizedBox(width: 6), Expanded(child: Text(tags, style: small())), PinButton(c: controller, msg: item.meta)]),
              Text(item.text, style: TextStyle(fontSize: 15, color: h.fg)),
              if (item.meta['picture'] != null)
                // only the phone that sent it has the picture; the Mac never sends it back
                controller.sentPictures[item.meta['ref']] != null
                    ? Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.memory(controller.sentPictures[item.meta['ref']]!, height: 160, fit: BoxFit.cover),
                        ),
                      )
                    : Padding(padding: const EdgeInsets.only(top: 4), child: Text('A picture', style: small())),
            ]),
          ),
        );
      case ItemKind.reply:
        final sayId = item.meta['say_id'] as String?;
        return GestureDetector(
          onLongPress: () => copyText(context, item.text),
          child: MsgCard(
            edge: h.accent,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              who([
                Text('Claude · ${item.meta['kind']}$time', style: small()),
                const SizedBox(width: 8),
                if (sayId != null)
                  SizedBox(
                    width: 32,
                    height: 32,
                    child: IconButton(
                      onPressed: () => controller.replay(sayId),
                      tooltip: 'Hear this again',
                      padding: EdgeInsets.zero,
                      icon: Icon(Icons.play_arrow_rounded, size: 18, color: h.fg),
                      style: IconButton.styleFrom(shape: CircleBorder(side: BorderSide(color: h.line))),
                    ),
                  ),
                const Spacer(),
                _PillButton(label: 'Copy', onPressed: () => copyText(context, item.text)),
                PinButton(c: controller, msg: item.meta),
              ]),
              Text(item.text, style: TextStyle(fontSize: 16, color: h.fg)),
            ]),
          ),
        );
      case ItemKind.detail:
        final key = item.meta['session_key'] as String?;
        return MsgCard(
          child: DetailCard(
            markdown: item.text,
            label: (item.meta['fallback'] == true ? 'Answered in the terminal' : 'Detail') + time,
            onChoice: (choice) => controller.answer(choice, key),
            trailing: PinButton(c: controller, msg: item.meta),
          ),
        );
      case ItemKind.picture:
        return MsgCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            who([Icon(Icons.image_outlined, size: 14, color: h.muted), const SizedBox(width: 6), Expanded(child: Text('Picture from Claude$time', style: small())), PinButton(c: controller, msg: item.meta)]),
            _ClaudePicture(id: item.meta['picture'] as String, controller: controller),
            if (item.text.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text(item.text, style: TextStyle(fontSize: 13, color: h.muted))),
          ]),
        );
      case ItemKind.approval:
        final id = item.meta['request_id'] as String;
        final done = item.resolution != null;
        final options = item.meta['options'] as List?;
        return MsgCard(
          fill: done ? null : h.warnSoft,
          border: done ? null : h.warn,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            who([
              Icon(Icons.lock_outline, size: 14, color: done ? h.muted : h.warn),
              const SizedBox(width: 6),
              Expanded(child: Text('${done ? (options != null ? 'Asked' : 'Approval') : 'NEEDS YOU'} · ${options != null ? 'Terminal · ${item.meta['session'] ?? ''}' : item.meta['tool_name']}$time', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: done ? h.muted : h.warn))),
            ]),
            Text(item.text, style: TextStyle(fontSize: 14, color: h.fg)),
            if ((item.meta['input_preview'] as String? ?? '').isNotEmpty)
              Container(
                margin: const EdgeInsets.only(top: 6),
                padding: const EdgeInsets.all(8),
                constraints: const BoxConstraints(maxHeight: 180),
                width: double.infinity,
                decoration: BoxDecoration(color: done ? h.bg : h.card, borderRadius: BorderRadius.circular(8)),
                child: SingleChildScrollView(child: Text(item.meta['input_preview'] as String, style: TextStyle(fontSize: 13, fontFamily: 'monospace', color: h.fg))),
              ),
            const SizedBox(height: 10),
            if (done)
              Text(item.resolution!, style: TextStyle(fontSize: 13, color: h.muted))
            else if (options != null)
              for (final (i, o) in options.indexed)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10)),
                      onPressed: () => controller.answerMenu(id, i),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(o['label'] as String, style: TextStyle(fontSize: 14, color: h.fg)),
                        if (o['detail'] != null) Text(o['detail'] as String, style: TextStyle(fontSize: 12, color: h.muted)),
                      ]),
                    ),
                  ),
                )
            else ...[
              if (controller.mode == 'passphrase')
                Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('Passphrase mode: say yes, then your passphrase. Or tap.', style: TextStyle(fontSize: 12.5, color: h.muted))),
              Row(children: [
                Expanded(child: FilledButton(onPressed: () => controller.approve(id, true), child: const Text('Allow'))),
                const SizedBox(width: 8),
                Expanded(child: OutlinedButton(onPressed: () => controller.approve(id, false), child: const Text('Deny'))),
              ]),
            ],
          ]),
        );
      case ItemKind.note:
        return Padding(padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4), child: Text(item.text, style: TextStyle(fontSize: 13, color: h.muted)));
      case ItemKind.metrics:
        return Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Text(item.text, style: small()));
    }
  }
}

/// When the Mac stamped a message: "12:41", "Yesterday 18:05" or "25 Oct 18:05" (the phone's 12/24 h setting).
String _when(BuildContext context, int at) {
  final t = DateTime.fromMillisecondsSinceEpoch(at);
  final now = DateTime.now();
  final clock = MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(t), alwaysUse24HourFormat: MediaQuery.of(context).alwaysUse24HourFormat);
  final days = DateTime(now.year, now.month, now.day).difference(DateTime(t.year, t.month, t.day)).inDays;
  if (days == 0) return clock;
  if (days == 1) return 'Yesterday $clock';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${t.day} ${months[t.month - 1]} $clock';
}

/// A screenshot Claude sent: loaded from the Mac when it comes on screen; tap for full screen, pinch to zoom.
class _ClaudePicture extends StatefulWidget {
  const _ClaudePicture({required this.id, required this.controller});
  final String id;
  final AppController controller;

  @override
  State<_ClaudePicture> createState() => _ClaudePictureState();
}

class _ClaudePictureState extends State<_ClaudePicture> {
  late Future<Uint8List?> data = widget.controller.loadPicture(widget.id);

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return FutureBuilder<Uint8List?>(
      future: data,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return SizedBox(height: 160, child: Center(child: CircularProgressIndicator(strokeWidth: 2, color: h.muted)));
        }
        final bytes = snap.data;
        if (bytes == null) {
          return Row(children: [
            Expanded(child: Text('This picture is no longer kept on the Mac (over a day old, or it restarted).', style: TextStyle(fontSize: 13, color: h.muted))),
            TextButton(onPressed: () => setState(() => data = widget.controller.loadPicture(widget.id)), child: const Text('Retry')),
          ]);
        }
        return GestureDetector(
          onTap: () => showDialog<void>(
            context: context,
            builder: (ctx) => Dialog.fullscreen(
              backgroundColor: Colors.black,
              child: Stack(children: [
                Positioned.fill(child: InteractiveViewer(maxScale: 5, child: Center(child: Image.memory(bytes)))),
                Positioned(
                  top: 8,
                  right: 8,
                  child: SafeArea(child: IconButton(onPressed: () => Navigator.pop(ctx), tooltip: 'Close', icon: const Icon(Icons.close, color: Colors.white))),
                ),
              ]),
            ),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 320), child: Image.memory(bytes, fit: BoxFit.contain)),
          ),
        );
      },
    );
  }
}

/// Pin or unpin a message (filled while pinned).
class PinButton extends StatelessWidget {
  const PinButton({super.key, required this.c, required this.msg});
  final AppController c;
  final Map<String, dynamic> msg;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final on = c.isPinned(msg);
    return IconButton(
      onPressed: () {
        HapticFeedback.selectionClick();
        c.setPin(msg, !on);
      },
      tooltip: on ? 'Unpin' : 'Pin this message',
      icon: Icon(on ? Icons.push_pin : Icons.push_pin_outlined, size: 16, color: on ? h.accent : h.muted),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 28),
    );
  }
}

/// A pinned message's first lines: the text, or a detail without its markdown.
String pinPreview(Map<String, dynamic> m) => switch (m['t']) {
      'user' => m['text'] as String? ?? '',
      'reply' => m['speak'] as String? ?? '',
      'picture' => (m['caption'] as String?) ?? 'A picture',
      _ => _detailPreview(m['markdown'] as String? ?? ''),
    };

String _detailPreview(String md) {
  final d = DetailDoc.parse(md);
  final head = [d.title, d.tldr].whereType<String>().map(plain).join(' · ');
  return head.isNotEmpty ? head : plain(md);
}

String _pinWho(Map<String, dynamic> m) => switch (m['t']) { 'user' => 'You', 'show' => 'Detail', 'picture' => 'Picture from Claude', _ => 'Claude' };

/// Above the chat when the session has pins: the latest one and the count. Tap for all of them.
class PinsBar extends StatelessWidget {
  const PinsBar({super.key, required this.c});
  final AppController c;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final mine = c.sessionPins;
    return Material(
      color: h.card,
      child: InkWell(
        onTap: () => showPins(context, c),
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 8, 10, 8),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: h.line))),
          child: Row(children: [
            Icon(Icons.push_pin, size: 16, color: h.accent),
            const SizedBox(width: 8),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(mine.length == 1 ? '1 pinned' : '${mine.length} pinned', style: TextStyle(fontSize: 12, color: h.muted)),
                Text(pinPreview(Map<String, dynamic>.from(mine.first['msg'] as Map)), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: h.fg)),
              ]),
            ),
            Icon(Icons.expand_more, color: h.muted),
          ]),
        ),
      ),
    );
  }
}

/// The session's pins in a sheet: tap one to read it in full, ✕ to unpin.
void showPins(BuildContext context, AppController c) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final h = Hf.of(context);
        final mine = c.sessionPins;
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: .6,
          maxChildSize: .92,
          builder: (_, scroll) => ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(12, 0, 12, 16), children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
              child: Text('Pinned${mine.isEmpty ? '' : ' (${mine.length})'}', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: h.fg)),
            ),
            if (mine.isEmpty) Padding(padding: const EdgeInsets.all(12), child: Text('Nothing pinned in this session.', style: TextStyle(color: h.muted))),
            for (final p in mine) _PinCard(c: c, pin: p),
          ]),
        );
      },
    ),
  );
}

class _PinCard extends StatefulWidget {
  const _PinCard({required this.c, required this.pin});
  final AppController c;
  final Map<String, dynamic> pin;

  @override
  State<_PinCard> createState() => _PinCardState();
}

class _PinCardState extends State<_PinCard> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final m = Map<String, dynamic>.from(widget.pin['msg'] as Map);
    final at = m['at'] as num?;
    final label = _pinWho(m) + (at == null ? '' : ' · ${_when(context, at.toInt())}');
    final unpin = IconButton(
      onPressed: () => widget.c.unpin(widget.pin['ref'] as String),
      tooltip: 'Unpin',
      icon: Icon(Icons.close, size: 16, color: h.muted),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 28),
    );
    if (open && m['t'] == 'show') {
      return MsgCard(child: DetailCard(markdown: m['markdown'] as String? ?? '', label: label, trailing: unpin, onChoice: (choice) => widget.c.answer(choice, m['session_key'] as String?)));
    }
    return GestureDetector(
      onTap: () => setState(() => open = !open),
      onLongPress: () => copyText(context, pinPreview(m)),
      child: MsgCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Expanded(child: Text(label, style: TextStyle(fontSize: 12, color: h.muted))), unpin]),
          Text(pinPreview(m), maxLines: open ? null : 3, overflow: open ? null : TextOverflow.ellipsis, style: TextStyle(fontSize: 15, color: h.fg)),
        ]),
      ),
    );
  }
}

class _PillButton extends StatelessWidget {
  const _PillButton({required this.label, required this.onPressed});
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(0, 30),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        shape: const StadiumBorder(),
        side: BorderSide(color: h.line),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
      child: Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400, color: h.fg)),
    );
  }
}

/// What Claude is doing in this session: "Working · step · time" with Stop Claude while
/// busy, then "Worked 2:10 · 9 steps" once done. Tap to see the steps.
class ActivityRow extends StatefulWidget {
  const ActivityRow({super.key, required this.c});
  final AppController c;

  @override
  State<ActivityRow> createState() => _ActivityRowState();
}

class _ActivityRowState extends State<ActivityRow> {
  Timer? _tick;
  bool open = false;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  static String _secs(num ms) {
    final s = (ms / 1000).round().clamp(0, 1 << 30);
    return s < 60 ? '${s}s' : '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final a = widget.c.currentActivity;
    final busy = a?['busy'] == true;
    final steps = ((a?['steps'] as List?) ?? const []).map((s) => Map<String, dynamic>.from(s as Map)).toList();
    if (busy) {
      _tick ??= Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
    } else {
      _tick?.cancel();
      _tick = null;
    }
    if (a == null || (!busy && steps.isEmpty)) return const SizedBox(height: 4);
    final now = DateTime.now().millisecondsSinceEpoch;
    final since = (a['since'] as num?) ?? now;
    final end = busy ? now : steps.fold<num>(since, (m, s) => (s['endedAt'] as num? ?? 0) > m ? s['endedAt'] as num : m);
    final running = steps.reversed.where((s) => s['endedAt'] == null).firstOrNull;
    final session = widget.c.activeSessionInfo;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Material(
          color: h.card,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: h.line)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: steps.isEmpty ? null : () => setState(() => open = !open),
            child: Container(
              constraints: const BoxConstraints(minHeight: 48),
              padding: const EdgeInsets.fromLTRB(12, 4, 6, 4),
              child: Row(children: [
                busy
                    ? SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, backgroundColor: h.accentSoft))
                    : Text('✓', style: TextStyle(color: h.good, fontWeight: FontWeight.w700)),
                const SizedBox(width: 10),
                Expanded(
                  child: Text.rich(
                    busy
                        ? TextSpan(children: [
                            TextSpan(text: 'Working', style: TextStyle(fontWeight: FontWeight.w600, color: h.fg)),
                            TextSpan(text: ' · ${running?['label'] ?? 'Thinking…'} · ${_secs(end - since)}', style: TextStyle(color: h.muted)),
                          ])
                        : TextSpan(text: 'Worked ${_secs(end - since)} · ${steps.length} step${steps.length == 1 ? '' : 's'}', style: TextStyle(color: h.muted)),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13.5),
                  ),
                ),
                if (busy)
                  OutlinedButton(
                    onPressed: () {
                      if (session != null && session['can_end'] == true) {
                        widget.c.interruptSession(session['key'] as String);
                      } else {
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('This session was started at the Mac. Press Esc there to stop Claude.')));
                      }
                    },
                    style: OutlinedButton.styleFrom(foregroundColor: h.bad, backgroundColor: Colors.transparent, side: BorderSide(color: h.bad), minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 12)),
                    child: const Text('Stop Claude', style: TextStyle(fontSize: 13)),
                  )
                else if (steps.isNotEmpty)
                  Padding(padding: const EdgeInsets.only(right: 6), child: Text(open ? 'Hide' : 'Show', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: h.accent))),
              ]),
            ),
          ),
        ),
        if (open && steps.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 4),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
            decoration: BoxDecoration(color: h.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: h.line)),
            child: Column(children: [
              for (final (i, s) in steps.indexed)
                Container(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  decoration: i == 0 ? null : BoxDecoration(border: Border(top: BorderSide(color: h.line))),
                  child: Row(children: [
                    SizedBox(
                      width: 16,
                      child: Text(
                        s['endedAt'] == null ? '•' : (s['ok'] == false ? '✗' : '✓'),
                        textAlign: TextAlign.center,
                        style: TextStyle(fontWeight: FontWeight.w700, color: s['endedAt'] == null ? h.accent : (s['ok'] == false ? h.bad : h.good)),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(child: Text(s['label'] as String? ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: h.fg))),
                    Text(_secs(((s['endedAt'] as num?) ?? now) - ((s['startedAt'] as num?) ?? now)), style: TextStyle(fontSize: 12.5, color: h.muted, fontFeatures: const [FontFeature.tabularFigures()])),
                  ]),
                ),
            ]),
          ),
      ]),
    );
  }
}

// --- voice bar ---------------------------------------------------------------------------

/// The voice bar's states, as on the web: label, colour, and the hint it starts with.
(String, Color) _voiceState(AppController c, Hf h) {
  if (c.link != 'online') return ('Offline', h.bad);
  if (c.speech == 'off') return ('Voice off', h.muted);
  if (c.speech == 'loading') return ('Starting voice', h.accent);
  if (c.recording) return ('Recording', Hf.recording);
  if (c.hearing && c.listening) return ('Hearing you', h.accent);
  if (c.state == 'speaking') return ('Speaking', h.accent);
  if (c.state == 'working' || c.state == 'transcribing' || c.currentActivity?['busy'] == true) return ('Thinking', h.accent);
  if (c.listening) return c.wakeOn && !c.wakeOpen ? ('Say “${c.wakePhrase}”', Hf.ready) : ('Listening', h.accent);
  return ('Mic off', h.muted);
}

class VoiceBar extends StatelessWidget {
  const VoiceBar({super.key, required this.c, required this.input});
  final AppController c;
  final TextEditingController input;

  void _send() {
    c.sendText(input.text);
    input.clear();
  }

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    final (label, color) = _voiceState(c, h);
    final off = c.link == 'online' && c.speech == 'off';
    final speaking = label == 'Speaking';
    final micOff = c.link != 'online' || c.speech != 'on' || (!c.listening && !c.recording);
    // yellow: listening for the wake phrase; green: awake, what you say goes to Claude
    // (Claude talking or working too: then only the wake phrase gets through as well)
    final waiting = c.wakeOn && !c.wakeOpen;
    final micColor = c.recording ? Hf.recording : micOff ? h.idle : waiting ? Hf.ready : h.accent;
    final soft = waiting ? Hf.ready.withValues(alpha: 0.22) : h.accentSoft;
    final ring = c.recording
        ? [BoxShadow(color: Hf.recording.withValues(alpha: 0.22), spreadRadius: 8)]
        : c.hearing
            ? [BoxShadow(color: soft, spreadRadius: 10)]
            : !micOff
                ? [BoxShadow(color: soft, spreadRadius: 6)]
                : null;
    final session = c.activeSessionInfo?['label'] as String?;
    return Container(
      decoration: BoxDecoration(color: h.bg, border: Border(top: BorderSide(color: h.line))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SizedBox(
              height: 36,
              child: Row(children: [
                _StateChip(label: label, color: color, bars: speaking, pulse: label == 'Listening' || label == 'Hearing you' || label == 'Recording'),
                const SizedBox(width: 8),
                if (off) ...[
                  Expanded(child: Text('Typing still works', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: h.muted))),
                  FilledButton(
                    onPressed: c.startVoice,
                    style: FilledButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 12)),
                    child: const Text('Start voice', style: TextStyle(fontSize: 13)),
                  ),
                ] else ...[
                  Expanded(
                    child: Text.rich(
                      TextSpan(children: [
                        if (session != null) ...[const TextSpan(text: 'Talking to '), TextSpan(text: session, style: TextStyle(fontWeight: FontWeight.w700, color: h.fg))],
                        if (c.muted) const TextSpan(text: ' · muted here'),
                      ]),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: h.muted),
                    ),
                  ),
                  if (speaking)
                    OutlinedButton(
                      onPressed: c.stopSpeaking,
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 12)),
                      child: const Text('Stop speaking', style: TextStyle(fontSize: 13)),
                    ),
                ],
              ]),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 2, bottom: 6, left: 2),
              child: Text(c.hint, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: h.muted)),
            ),
            if (c.pendingPicture != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(children: [
                  ClipRRect(borderRadius: BorderRadius.circular(6), child: Image.memory(c.pendingPicture!, height: 44, width: 44, fit: BoxFit.cover)),
                  const SizedBox(width: 8),
                  Expanded(child: Text('Picture attached', style: TextStyle(fontSize: 13, color: h.muted))),
                  IconButton(onPressed: c.clearPicture, icon: const Icon(Icons.close, size: 18), tooltip: 'Remove the picture'),
                ]),
              ),
            Row(children: [
              IconButton(
                onPressed: () => _pickPicture(context, c),
                tooltip: 'Send Claude a picture',
                icon: const Icon(Icons.image_outlined, size: 20),
                style: IconButton.styleFrom(
                  fixedSize: const Size(44, 44),
                  backgroundColor: h.card,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: h.line)),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: input,
                  minLines: 1,
                  maxLines: 3, // grows to 3 lines, then scrolls
                  keyboardType: TextInputType.multiline, // the keyboard's Enter is a new line; the send button sends
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: 'Type a message',
                    suffixIcon: IconButton(onPressed: _send, tooltip: 'Send', icon: Icon(Icons.send, size: 18, color: h.accent)),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Semantics(
                button: true,
                label: 'Mic: tap for hands-free, hold to talk',
                child: GestureDetector(
                  // tap: hands-free on/off · hold: talk, let go to send
                  onTap: c.toggleListening,
                  onLongPressStart: (_) => c.pttStart(),
                  onLongPressEnd: (_) => c.pttEnd(),
                  onLongPressCancel: c.pttEnd,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 60,
                    height: 60,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: micColor, boxShadow: ring),
                    child: Icon(c.link != 'online' || c.speech == 'off' ? Icons.mic_off : Icons.mic, color: c.recording ? Colors.white : h.onAccent, size: 26),
                  ),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// The state chip: a dot (pulsing while it listens) or sound bars while Claude speaks.
class _StateChip extends StatefulWidget {
  const _StateChip({required this.label, required this.color, required this.bars, required this.pulse});
  final String label;
  final Color color;
  final bool bars;
  final bool pulse;

  @override
  State<_StateChip> createState() => _StateChipState();
}

class _StateChipState extends State<_StateChip> with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_StateChip old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final move = widget.bars || widget.pulse;
    if (move && !_a.isAnimating) _a.repeat();
    if (!move && _a.isAnimating) _a.stop();
  }

  @override
  void dispose() {
    _a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 3, 10, 3),
      decoration: BoxDecoration(color: h.card, borderRadius: BorderRadius.circular(99), border: Border.all(color: h.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        AnimatedBuilder(
          animation: _a,
          builder: (_, _) {
            if (widget.bars) {
              return SizedBox(
                height: 11,
                child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  for (var i = 0; i < 3; i++) ...[
                    if (i > 0) const SizedBox(width: 2),
                    Container(
                      width: 3,
                      height: 11 * (0.35 + 0.65 * (0.5 - 0.5 * _cos((_a.value - i * 0.17) * 2))),
                      decoration: BoxDecoration(color: widget.color, borderRadius: BorderRadius.circular(2)),
                    ),
                  ],
                ]),
              );
            }
            final o = widget.pulse ? 0.3 + 0.7 * (0.5 + 0.5 * _cos(_a.value * 2)) : 1.0;
            return Opacity(opacity: o, child: Container(width: 8, height: 8, decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle)));
          },
        ),
        const SizedBox(width: 7),
        Text(widget.label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: widget.color)),
      ]),
    );
  }
}

/// cos of a turn (1 turn = 2π), for the chip's little animations.
double _cos(double turns) => math.cos(turns * 2 * math.pi);

// --- dialogs -------------------------------------------------------------------------------

/// A screenshot or photo for Claude, shrunk on the phone (long side 1600 px) so it sends quickly.
Future<void> _pickPicture(BuildContext context, AppController c) async {
  final source = await showModalBottomSheet<ImageSource>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Gallery or screenshots'), onTap: () => Navigator.pop(ctx, ImageSource.gallery)),
        ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.pop(ctx, ImageSource.camera)),
      ]),
    ),
  );
  if (source == null) return;
  final file = await ImagePicker().pickImage(source: source, maxWidth: 1600, maxHeight: 1600, imageQuality: 85);
  if (file != null) c.attachPicture(await file.readAsBytes());
}

/// Sessions the phone started only (the Mac types /rename into them).
Future<void> _rename(BuildContext context, AppController c) async {
  final s = c.activeSessionInfo;
  if (s == null) return;
  final field = TextEditingController(text: s['label'] as String);
  final name = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Rename session'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(controller: field, autofocus: true, maxLength: 60, onSubmitted: (v) => Navigator.pop(ctx, v)),
        const Text('Works while Claude is idle. The new name also shows in the past chats.'),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, field.text), child: const Text('Rename')),
      ],
    ),
  );
  if (name != null && name.trim().isNotEmpty && name.trim() != s['label']) c.renameSession(s['key'] as String, name.trim());
}

Future<void> _confirmEnd(BuildContext context, AppController c) async {
  final s = c.activeSessionInfo;
  if (s == null) return;
  final ok = await showDialog<bool>(
    context: context,
    builder: (d) => AlertDialog(
      title: Text('End ${s['label']}?'),
      content: const Text('Claude stops what it\'s doing and exits. The chat stays in Claude Code: pick it from the past chats under New session to carry on.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Hf.of(d).bad, foregroundColor: Colors.white),
          onPressed: () => Navigator.pop(d, true),
          child: const Text('End'),
        ),
      ],
    ),
  );
  if (ok == true) c.endSession(s['key'] as String);
}
