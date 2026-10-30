import 'package:flutter/material.dart';

import 'controller.dart';

/// Start a Claude session on the Mac: pick a folder (pinned, recent, or from a workspace),
/// then the Claude profile and a new chat or a past one. The Mac runs claude-voice there in tmux.
class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({super.key, required this.c});
  final AppController c;

  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  @override
  void initState() {
    super.initState();
    widget.c.browse();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final tabs = [
          if (c.pinned.isNotEmpty) ('Pinned', [for (final p in c.pinned) _Folder(p['cwd'] as String, p['name'] as String)]),
          ('Recent', [for (final p in c.projects) _Folder(p['cwd'] as String, p['name'] as String, recent: true)]),
          for (final w in c.workspaces)
            (w['name'] as String, [for (final f in (w['folders'] as List)) _Folder((f as Map)['cwd'] as String, f['name'] as String)]),
        ];
        return DefaultTabController(
          // a workspace can appear after the first build: a new controller per tab count
          key: ValueKey(tabs.length),
          length: tabs.length,
          child: Scaffold(
            appBar: AppBar(
              title: const Text('New session'),
              bottom: TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final t in tabs) Tab(text: t.$1)]),
            ),
            body: Column(children: [
              if (c.fullDisk == false) const _AccessBanner(),
              Expanded(child: TabBarView(children: [
              for (final t in tabs)
                t.$2.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text('Nothing here yet. Folders where voice sessions ran show up under Recent; '
                              'add pinned folders and workspaces in ~/.handfree/config.json on the Mac.', textAlign: TextAlign.center),
                        ),
                      )
                    : ListView(children: [for (final f in t.$2) _folderTile(context, f)]),
              ])),
            ]),
          ),
        );
      },
    );
  }

  Widget _folderTile(BuildContext context, _Folder f) {
    return ListTile(
      leading: const Icon(Icons.folder_outlined),
      title: Text(f.name),
      subtitle: Text(f.cwd, maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => _ChatPicker(c: widget.c, folder: f))),
      onLongPress: f.recent ? () => _forget(context, f) : null,
    );
  }

  Future<void> _forget(BuildContext context, _Folder f) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Remove ${f.name} from Recent?'),
        content: const Text('It comes back the next time a voice session runs there.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok == true) {
      widget.c.forgetProject(f.cwd);
      widget.c.browse();
    }
  }
}

/// The Mac's daemon can't read Downloads and the like without asking, and nobody is
/// there to click the popup: the session waits. One setting on the Mac fixes it.
class _AccessBanner extends StatelessWidget {
  const _AccessBanner();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Container(
      width: double.infinity,
      color: t.colorScheme.tertiaryContainer,
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      child: Text(
        'A session started from here can stop at a macOS permission popup on the Mac '
        '(“bun would like to access…”). Fix it once at the Mac: run handfree permissions.',
        style: t.textTheme.bodySmall?.copyWith(color: t.colorScheme.onTertiaryContainer),
      ),
    );
  }
}

class _Folder {
  const _Folder(this.cwd, this.name, {this.recent = false});
  final String cwd;
  final String name;
  final bool recent;
}

/// The Claude profile, then a new chat or one of the folder's past chats (titles from
/// that profile's Claude Code history).
class _ChatPicker extends StatefulWidget {
  const _ChatPicker({required this.c, required this.folder});
  final AppController c;
  final _Folder folder;

  @override
  State<_ChatPicker> createState() => _ChatPickerState();
}

class _ChatPickerState extends State<_ChatPicker> {
  /// The profile you picked; until then, the folder's own (the Mac says which).
  String? _picked;

  String? get _profile => _picked ?? widget.c.chatsProfile[widget.folder.cwd];

  @override
  void initState() {
    super.initState();
    widget.c.loadChats(widget.folder.cwd);
  }

  void _pick(String profile) {
    setState(() => _picked = profile);
    widget.c.loadChats(widget.folder.cwd, profile: profile);
  }

  void _start({String? chat}) {
    widget.c.startSession(widget.folder.cwd, chat: chat, profile: _profile);
    Navigator.popUntil(context, (r) => r.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.folder.name)),
      body: ListenableBuilder(
        listenable: widget.c,
        builder: (context, _) {
          final chats = widget.c.chats[widget.folder.cwd];
          final profile = _profile;
          final profiles = {...widget.c.profiles, ?profile}.toList();
          return ListView(children: [
            if (profiles.length > 1)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: SegmentedButton<String>(
                  segments: [for (final p in profiles) ButtonSegment(value: p, label: Text(p))],
                  selected: {?profile},
                  emptySelectionAllowed: true,
                  showSelectedIcon: false,
                  onSelectionChanged: (s) => s.isEmpty ? null : _pick(s.first),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: FilledButton.icon(onPressed: _start, icon: const Icon(Icons.add_comment_outlined), label: const Text('New chat')),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text('Or continue a past chat', style: t.textTheme.titleSmall),
            ),
            if (chats == null)
              const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
            else if (chats.isEmpty)
              const Padding(padding: EdgeInsets.all(16), child: Text('No past chats in this folder.'))
            else
              for (final ch in chats)
                ListTile(
                  leading: const Icon(Icons.history),
                  title: Text(ch['title'] as String, maxLines: 2, overflow: TextOverflow.ellipsis),
                  subtitle: Text(_when((ch['updated'] as num).toInt())),
                  onTap: () => _start(chat: ch['id'] as String),
                ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text('A chat that is already open in another session should be continued there, not here.', style: t.textTheme.bodySmall),
            ),
          ]);
        },
      ),
    );
  }
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "today 14:05", "yesterday", "Oct 19"
String _when(int ms) {
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  final days = DateTime(now.year, now.month, now.day).difference(DateTime(d.year, d.month, d.day)).inDays;
  if (days == 0) return 'today ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  if (days == 1) return 'yesterday';
  return '${_months[d.month - 1]} ${d.day}${d.year != now.year ? ', ${d.year}' : ''}';
}
