import 'package:flutter/material.dart';

import 'controller.dart';
import 'theme.dart';

/// Everything the web page's Settings has, plus what only the phone needs:
/// voice on the Mac, the connection, and unpairing.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key, required this.c, required this.onUnpair});
  final AppController c;
  final VoidCallback onUnpair;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListenableBuilder(
        listenable: Listenable.merge([c, lookPrefs]),
        builder: (context, _) {
          final h = Hf.of(context);
          final online = c.link == 'online';
          final voiceNote = switch (c.speech) {
            'on' => 'On · uses about 4 GB on the Mac, turns off after 30 min idle',
            'loading' => 'Starting… about 4 seconds',
            _ => 'Off · typing still works, replies come as text',
          };
          return ListView(padding: const EdgeInsets.fromLTRB(12, 4, 12, 24), children: [
            const _Heading('Voice'),
            _Group(children: [
              _Row(
                title: 'Voice on the Mac',
                note: voiceNote,
                trailing: c.speech == 'loading'
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : c.speech == 'on'
                        ? OutlinedButton(onPressed: online ? c.stopVoice : null, child: const Text('Stop voice'))
                        : FilledButton(onPressed: online ? c.startVoice : null, child: const Text('Start voice')),
              ),
              _Switch('Wake word', 'Hands-free turns reach Claude only after the phrase. Holding the mic and typing always do.', c.wakeOn, online ? (on) => c.setWake(on: on) : null),
              _Row(
                title: 'Wake phrase',
                note: '“${c.wakePhrase}”',
                trailing: TextButton(onPressed: online ? () => editWakePhrase(context, c) : null, child: const Text('Change')),
              ),
              _Switch('Interrupt by voice', 'Talk over Claude to stop it (best with earbuds)', c.bargeIn, c.setBargeIn),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('Language', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: h.fg)),
                  const SizedBox(height: 2),
                  Text('What you speak. Rojak: Malay and English mixed, with lah, tapau and friends. Auto guesses each time.', style: TextStyle(fontSize: 12.5, color: h.muted)),
                  const SizedBox(height: 8),
                  SegmentedButton<String>(
                    segments: const [ButtonSegment(value: 'en', label: Text('English')), ButtonSegment(value: 'rojak', label: Text('Rojak')), ButtonSegment(value: 'auto', label: Text('Auto'))],
                    selected: {c.language},
                    showSelectedIcon: false,
                    onSelectionChanged: online ? (s) => c.setLanguage(s.first) : null,
                  ),
                ]),
              ),
              _Switch('Speak every session', 'Off: only the session you are talking to speaks; the others show as text', c.speakAll, online ? c.setSpeakAll : null),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('My voice only', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: h.fg)),
                  const SizedBox(height: 2),
                  Text(_myVoiceNote(c), style: TextStyle(fontSize: 12.5, color: h.muted)),
                  const SizedBox(height: 8),
                  SegmentedButton<String>(
                    segments: const [ButtonSegment(value: 'off', label: Text('Off')), ButtonSegment(value: 'watch', label: Text('Watch')), ButtonSegment(value: 'on', label: Text('On'))],
                    selected: {c.myVoice},
                    showSelectedIcon: false,
                    onSelectionChanged: online ? (s) => c.setMyVoice(s.first) : null,
                  ),
                  if (c.myVoice != 'off' && ((c.myVoiceInfo['learned'] as num?) ?? 0) > 0)
                    Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: online ? c.resetMyVoice : null, child: const Text('Retrain my voice'))),
                ]),
              ),
              _Switch('Mute on this phone', 'Replies show as text here; other devices still speak', c.muted, c.setMuted),
              _Switch('Done sounds', 'A chime when Claude finishes or needs your OK', c.sounds, c.setSounds),
            ]),
            const _Heading('Approvals'),
            _Group(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('How Claude’s permission requests are answered', style: TextStyle(fontSize: 12.5, color: h.muted)),
                  const SizedBox(height: 8),
                  SegmentedButton<String>(
                    segments: const [ButtonSegment(value: 'tap', label: Text('Tap')), ButtonSegment(value: 'passphrase', label: Text('Passphrase'))],
                    selected: {c.mode},
                    showSelectedIcon: false,
                    onSelectionChanged: online ? (s) => c.setMode(s.first) : null,
                  ),
                  if (c.mode == 'passphrase' || !c.passphraseSet)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        c.passphraseSet ? 'Say yes, then your passphrase, to allow. Tapping Allow still works.' : 'No passphrase is set on the Mac yet, so Passphrase mode works like Tap.',
                        style: TextStyle(fontSize: 12.5, color: h.muted),
                      ),
                    ),
                ]),
              ),
            ]),
            const _Heading('Look'),
            _Group(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('Theme', style: TextStyle(fontWeight: FontWeight.w600, color: h.fg)),
                  const SizedBox(height: 6),
                  SegmentedButton<String>(
                    segments: const [ButtonSegment(value: 'auto', label: Text('Auto')), ButtonSegment(value: 'light', label: Text('Light')), ButtonSegment(value: 'dark', label: Text('Dark'))],
                    selected: {lookPrefs.theme},
                    showSelectedIcon: false,
                    onSelectionChanged: (s) => lookPrefs.setTheme(s.first),
                  ),
                  const SizedBox(height: 14),
                  Text('Text size', style: TextStyle(fontWeight: FontWeight.w600, color: h.fg)),
                  const SizedBox(height: 6),
                  SegmentedButton<bool>(
                    segments: const [ButtonSegment(value: false, label: Text('Normal')), ButtonSegment(value: true, label: Text('Large'))],
                    selected: {lookPrefs.large},
                    showSelectedIcon: false,
                    onSelectionChanged: (s) => lookPrefs.setLarge(s.first),
                  ),
                ]),
              ),
            ]),
            const _Heading('Connection'),
            _Group(children: [
              _Row(
                leading: Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: online ? h.accent : h.bad)),
                title: online ? 'Connected to ${c.info.name}' : 'Not connected to ${c.info.name}',
                note: online
                    ? '${c.viaTailscale ? 'via Tailscale' : 'on the home network'} · ${c.host}${c.info.hosts.length > 1 ? ' · knows ${c.info.hosts.length} addresses' : ''}'
                    : 'Trying ${c.info.hosts.join(', ')}',
              ),
              if (c.fullDisk == false)
                _Row(
                  fill: h.warnSoft,
                  title: 'Mac permission pop-ups',
                  note: 'Full Disk Access is off, so the Mac may stop and wait for a click',
                  trailing: OutlinedButton(
                    onPressed: () => showFullDiskHelp(context),
                    style: OutlinedButton.styleFrom(foregroundColor: h.warn, backgroundColor: Colors.transparent, side: BorderSide(color: h.warn)),
                    child: const Text('How to fix'),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton(
                    onPressed: () => _confirmUnpair(context),
                    style: OutlinedButton.styleFrom(foregroundColor: h.bad, backgroundColor: Colors.transparent, side: BorderSide(color: h.bad)),
                    child: Text('Unpair from ${c.info.name}'),
                  ),
                ),
              ),
            ]),
          ]);
        },
      ),
    );
  }

  Future<void> _confirmUnpair(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Unpair from ${c.info.name}?'),
        content: const Text('To use Handfree again you will need a new pairing code from the Mac.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Hf.of(d).bad, foregroundColor: Colors.white),
            onPressed: () => Navigator.pop(d, true),
            child: const Text('Unpair'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    Navigator.of(context).popUntil((r) => r.isFirst);
    onUnpair();
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
        child: Text(text.toUpperCase(), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.7, color: Hf.of(context).muted)),
      );
}

/// A white card holding rows, with lines between them.
class _Group extends StatelessWidget {
  const _Group({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: h.card, borderRadius: BorderRadius.circular(14), border: Border.all(color: h.line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, w) in children.indexed)
          Container(decoration: i == 0 ? null : BoxDecoration(border: Border(top: BorderSide(color: h.line))), child: w),
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, this.note, this.trailing, this.leading, this.fill});
  final String title;
  final String? note;
  final Widget? trailing;
  final Widget? leading;
  final Color? fill;

  @override
  Widget build(BuildContext context) {
    final h = Hf.of(context);
    return Container(
      color: fill,
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
      child: Row(children: [
        if (leading != null) ...[leading!, const SizedBox(width: 12)],
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: h.fg)),
            if (note != null) Text(note!, style: TextStyle(fontSize: 12.5, color: h.muted)),
          ]),
        ),
        if (trailing != null) ...[const SizedBox(width: 12), trailing!],
      ]),
    );
  }
}

class _Switch extends StatelessWidget {
  const _Switch(this.title, this.note, this.value, this.onChanged);
  final String title;
  final String note;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) => _Row(title: title, note: note, trailing: Switch(value: value, onChanged: onChanged));
}

Future<void> editWakePhrase(BuildContext context, AppController c) async {
  final field = TextEditingController(text: c.wakePhrase);
  final phrase = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Wake phrase'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(controller: field, autofocus: true, maxLength: 40, onSubmitted: (v) => Navigator.pop(ctx, v)),
        const Text('Two or three clear words you rarely say otherwise, like “Hey Claude”.'),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, field.text), child: const Text('Save')),
      ],
    ),
  );
  if (phrase != null && phrase.trim().isNotEmpty) c.setWake(phrase: phrase.trim());
}

/// What to do on the Mac so a session started from the phone doesn't stall at a
/// macOS "allow access?" pop-up nobody can click.
Future<void> showFullDiskHelp(BuildContext context) => showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Mac permission pop-ups'),
        content: const Text(
          'Handfree on the Mac doesn’t have Full Disk Access, so macOS may show an “allow access?” pop-up and wait for a click.\n\n'
          'Fix at the Mac: run “handfree permissions” in Terminal. It opens Privacy & Security › Full Disk Access; turn on “bun”.\n\n'
          'Or leave it off and approve pop-ups with Screen Sharing.',
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(d), child: const Text('OK'))],
      ),
    );

/// What "my voice only" is doing, in one line.
String _myVoiceNote(AppController c) {
  final i = c.myVoiceInfo;
  final counts = Map<String, dynamic>.from((i['counts'] as Map?) ?? {});
  final learned = (i['learned'] as num?)?.toInt() ?? 0;
  if (c.myVoice == 'off') return 'Ignore voices that aren’t yours, or are far from the mic. Watch notes what it would drop, without dropping.';
  if (i['ready'] != true) return 'Learning your voice from your messages: $learned of 10';
  return 'Knows your voice ($learned messages) · ${c.myVoice == 'on' ? 'dropped' : 'would drop'}: ${counts['other'] ?? 0} not you, ${counts['far'] ?? 0} far away';
}
