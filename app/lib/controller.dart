import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:permission_handler/permission_handler.dart';

import 'audio.dart';
import 'connection.dart';
import 'pairing.dart';

enum ItemKind { user, reply, detail, picture, approval, note, metrics }

class Item {
  Item(this.kind, this.text, {this.meta = const {}});
  final ItemKind kind;
  final String text;
  final Map<String, dynamic> meta;
  String? resolution; // approvals: "Approved by tap", ...
}

/// What a session is doing, like the web's status: needs you, asked you, working,
/// speaking, done or idle. [group] is where the sidebar lists it.
class SessionStatus {
  const SessionStatus(this.kind, this.label, this.line);
  final String kind;
  final String label;
  final String line;
  String get group => switch (kind) { 'needs' || 'ask' => 'needs', 'working' || 'speaking' => 'working', _ => 'idle' };
}

const stateText = {
  'starting': 'Starting voices…',
  'idle': 'Ready',
  'transcribing': 'Hearing you…',
  'working': 'Claude is working',
  'speaking': 'Speaking',
  'approval': 'Needs approval',
};

/// App state: the daemon link, the native audio engine and what's on screen.
class AppController extends ChangeNotifier {
  AppController(this.info, this.store);

  final PairInfo info;
  final PairStore store;
  final audio = NativeAudio();
  late final Connection conn;

  final items = <Item>[];

  /// The chat of the session you're on (each session keeps its own); approvals and notes show everywhere.
  List<Item> get visibleItems {
    if (activeSession == null) return items;
    return items.where((i) => i.kind == ItemKind.approval || i.meta['session_key'] == null || i.meta['session_key'] == activeSession).toList();
  }
  final pending = <String, Map<String, dynamic>>{}; // open approvals by request id

  /// Pinned messages of every session; the Mac keeps them, each with a copy of its message.
  var pins = <Map<String, dynamic>>[];
  /// A message's id for pinning, the same as the Mac's: its own id, or (saved before those existed) type, msg_id and time.
  static String pinRef(Map<String, dynamic> m) => m['id'] as String? ?? '${m['t']}:${m['msg_id'] ?? ''}:${m['at']}';
  bool isPinned(Map<String, dynamic> m) => pins.any((p) => p['ref'] == pinRef(m));
  void setPin(Map<String, dynamic> m, bool on) => conn.send({'t': 'pin', 'ref': pinRef(m), 'on': on});
  void unpin(String ref) => conn.send({'t': 'pin', 'ref': ref, 'on': false});
  /// The session you're on: its pins, the last pinned first.
  List<Map<String, dynamic>> get sessionPins => pins.where((p) => p['session_key'] == activeSession).toList()
    ..sort((a, b) => (b['pinned_at'] as num).compareTo(a['pinned_at'] as num));
  final menus = <String, Map<String, dynamic>>{}; // open terminal menus by request id
  String link = 'connecting';
  String state = 'starting';
  /// The Mac's speech models: off (until someone taps Start voice), loading (~4 s), on.
  String speech = 'off';
  String mode = 'tap';
  bool passphraseSet = false;
  List<Map<String, dynamic>> sessions = [];
  String? activeSession;
  /// Folders where voice sessions ran, most recent first: the phone can start a new session in one.
  List<Map<String, dynamic>> projects = [];
  /// Your workspaces on the Mac and the project folders in each (sent when New session opens).
  List<Map<String, dynamic>> workspaces = [];
  /// Folders you listed in the Mac's config (`pinned`), shown first.
  List<Map<String, dynamic>> pinned = [];
  /// Claude profiles to start a session with (default, work, personal, …).
  List<String> profiles = [];
  /// Past chats per folder, newest first; missing while the Mac is reading them.
  final chats = <String, List<Map<String, dynamic>>>{};
  /// The profile each folder's chats were read from (picked, or the folder's own).
  final chatsProfile = <String, String>{};
  /// false: the Mac's daemon has no Full Disk Access, so a session started from here
  /// can stall at a macOS permission popup. null: unknown or not a Mac.
  bool? fullDisk;
  /// Claude's voice plays at volume 0 on this phone (kept on the phone).
  bool muted = false;
  /// A picture waiting to go with the next message you send (shrunk JPEG or PNG bytes).
  Uint8List? pendingPicture;
  /// Pictures this phone sent, by ref, for their thumbnails in the chat (this run only).
  final sentPictures = <String, Uint8List>{};
  /// Screenshots Claude sent, by id, once loaded from the Mac (this run only).
  final claudePictures = <String, Uint8List>{};
  final _pictureWaits = <String, Completer<Uint8List?>>{};
  static const _storage = FlutterSecureStorage();
  Map<String, dynamic>? get activeSessionInfo => sessions.where((s) => s['key'] == activeSession).firstOrNull;
  bool listening = false;
  bool hearing = false;
  bool bargeIn = true;
  bool waiting = false; // you paused mid-thought and the daemon is waiting for more
  // wake word: hands-free turns reach Claude after the phrase, or right after an answer
  bool wakeOn = true;
  String wakePhrase = 'Hey Claude';
  bool wakeOpen = false;
  /// Speak replies from every session (off: only the one you're talking to). Kept on the Mac.
  bool speakAll = true;
  /// What you speak, kept on the Mac: en, rojak (Malay and English mixed) or auto.
  String language = 'en';
  /// "my voice only" on the Mac: off, watch (notes what it would drop) or on.
  String myVoice = 'off';
  /// what the Mac has learned: {learned, ready, counts: {other, far, …}}
  Map<String, dynamic> myVoiceInfo = const {};
  /// Done and approval chimes on this phone.
  bool sounds = true;
  bool _serviceStarted = false; // the mic-type service needs mic permission first
  String hint = 'Tap the mic to talk hands-free, or hold it to talk.';

  /// What Claude is doing right now, per session key: {busy, since, steps}.
  final activity = <String, Map<String, dynamic>>{};
  Map<String, dynamic>? get currentActivity => activeSession == null ? null : activity[activeSession];
  String _lastFinal = ''; // Claude's last spoken answer, for the "done" notification
  String? _lastSayId; // Claude's last spoken reply, for the notification's Replay
  bool _replaying = false;

  /// Per session: when you last spoke, Claude's last reply and detail, for its status.
  final _seen = <String, Map<String, dynamic>>{};
  String? _lastSpeakKey;

  // hold-to-talk: frames collect here while the mic button is held
  List<Uint8List>? _ptt;
  bool _playing = false;
  Map<String, dynamic>? _pos; // the sentence playing now, for "interrupted after"
  Map<String, dynamic>? _pttDuring;

  final _subs = <StreamSubscription>[];

  void start() {
    conn = Connection(info, onMessage: _onMessage, onStatus: _onLink, onPaired: (i) => store.save(i));
    _subs.add(audio.events.listen(_onAudioEvent));
    _subs.add(audio.micFrames.listen((frame) {
      if (_ptt != null) {
        _ptt!.add(frame);
      } else if (listening) {
        conn.sendAudio(frame);
      }
    }));
    conn.start();
    _storage.read(key: 'handfree.muted').then((v) {
      if (v == 'on') setMuted(true);
    });
    _storage.read(key: 'handfree.sounds').then((v) {
      sounds = v != 'off';
      notifyListeners();
    });
    checkShared();
  }

  /// A picture shared to Handfree from the gallery, WhatsApp, a screenshot…: it waits
  /// in the input box for your question.
  Future<void> checkShared() async {
    final bytes = await audio.takeShared();
    if (bytes != null) attachPicture(bytes);
  }

  void attachPicture(Uint8List bytes) {
    pendingPicture = bytes;
    hint = 'Picture attached. Type a question, or just send it.';
    notifyListeners();
  }

  void clearPicture() {
    pendingPicture = null;
    notifyListeners();
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    conn.close();
    super.dispose();
  }

  // --- user actions -----------------------------------------------------------------

  Future<void> toggleListening() async {
    if (speech != 'on') return _voiceNotOn();
    return listening ? stopListening() : startListening();
  }

  /// Load the speech models on the Mac, for every device at once.
  void startVoice() {
    conn.send({'t': 'speech', 'on': true});
    hint = 'Starting voice… about 4 seconds.';
    notifyListeners();
  }

  void stopVoice() => conn.send({'t': 'speech', 'on': false});

  void _voiceNotOn() {
    hint = speech == 'off' ? 'Voice is off. Tap Start voice first, or type.' : 'Starting voice… about 4 seconds.';
    notifyListeners();
  }

  void _speech(String status) {
    final was = speech;
    speech = status;
    if (status == 'off') {
      if (listening) stopListening();
      hint = 'Voice is off on the Mac. Tap Start voice, or type.';
    } else if (status == 'loading') {
      hint = 'Starting voice… about 4 seconds.';
    } else if (was != 'on') {
      hint = 'Voice is on. Tap the mic to talk hands-free, or hold it to talk.';
    }
  }

  /// Permissions, the foreground service and the mic. False (with a hint) if not.
  Future<bool> _openMic() async {
    final statuses = await [Permission.microphone, Permission.notification].request();
    if (statuses[Permission.microphone] != PermissionStatus.granted) {
      hint = 'Microphone permission is needed to talk.';
      notifyListeners();
      return false;
    }
    await audio.startService();
    _serviceStarted = true;
    if (!await audio.startMic()) {
      hint = 'Could not open the microphone.';
      notifyListeners();
      return false;
    }
    return true;
  }

  Future<void> startListening() async {
    if (!await _openMic()) return;
    listening = true;
    conn.send({'t': 'stream', 'on': true, 'barge_in': bargeIn});
    hint = 'Listening. Just talk.';
    notifyListeners();
    _updateNotification();
  }

  Future<void> stopListening() async {
    listening = false;
    hearing = false;
    conn.send({'t': 'stream', 'on': false});
    await audio.stopMic();
    hint = 'Paused. Tap the mic to listen again.';
    notifyListeners();
    _updateNotification();
  }

  /// Hold-to-talk: the turn goes as one message the moment you let go, with no
  /// pause detection. Works with hands-free listening on or off.
  Future<void> pttStart() async {
    if (_ptt != null) return;
    if (speech != 'on') return _voiceNotOn();
    _ptt = [];
    if (listening) {
      conn.send({'t': 'stream', 'on': false}); // the daemon's pause detection sits this one out
    } else if (!await _openMic()) {
      _ptt = null;
      return;
    }
    if (_playing) { // you want the floor
      _pttDuring = _pos;
      audio.pause();
    }
    hearing = true;
    hint = 'Recording… let go to send.';
    HapticFeedback.mediumImpact();
    notifyListeners();
  }

  Future<void> pttEnd() async {
    final frames = _ptt;
    _ptt = null;
    if (frames == null) return;
    hearing = false;
    if (listening) {
      conn.send({'t': 'stream', 'on': true, 'barge_in': bargeIn});
    } else {
      await audio.stopMic();
    }
    final bytes = BytesBuilder(copy: false);
    for (final f in frames) {
      bytes.add(f);
    }
    final during = _pttDuring;
    _pttDuring = null;
    if (bytes.length < 16000 * 2 * 0.3) { // a tap, not a turn
      if (during != null) audio.resume();
      hint = listening ? 'Listening. Just talk.' : 'Hold the mic to talk, or tap it for hands-free.';
      return notifyListeners();
    }
    conn.send({'t': 'utterance', 'pcm16': base64Encode(bytes.takeBytes()), 'ptt': true, 'during': ?during});
    HapticFeedback.lightImpact();
    hint = 'Got it…';
    notifyListeners();
  }

  void setWake({bool? on, String? phrase}) => conn.send({'t': 'wake_config', 'on': ?on, 'phrase': ?phrase});

  void _wake(Map<String, dynamic> m) {
    final was = wakeOpen;
    wakeOn = m['on'] == true;
    wakePhrase = m['phrase'] as String? ?? wakePhrase;
    wakeOpen = m['open'] == true;
    if (!wakeOn || !listening) return;
    if (wakeOpen) {
      if (m['woken'] == true) HapticFeedback.mediumImpact();
      hint = 'Listening to you… say “that’s all” when you’re done.';
    } else if (was && m['quiet'] != true) {
      HapticFeedback.selectionClick();
      hint = 'Say “$wakePhrase” to talk to Claude.';
    }
  }

  void setMuted(bool on) {
    muted = on;
    audio.setMuted(on);
    _storage.write(key: 'handfree.muted', value: on ? 'on' : 'off');
    notifyListeners();
  }

  void setSounds(bool on) {
    sounds = on;
    _storage.write(key: 'handfree.sounds', value: on ? 'on' : 'off');
    notifyListeners();
  }

  void setSpeakAll(bool on) => conn.send({'t': 'voice_config', 'speak_all': on});

  void setMyVoice(String mode) => conn.send({'t': 'voice_config', 'my_voice': mode});

  void setLanguage(String language) => conn.send({'t': 'voice_config', 'language': language});

  void resetMyVoice() => conn.send({'t': 'my_voice_reset'});

  void _myVoice(Map<String, dynamic> m) {
    if (m['my_voice'] is String) myVoice = m['my_voice'] as String;
    if (m['language'] is String) language = m['language'] as String;
    if (m['my_voice_info'] is Map) myVoiceInfo = Map<String, dynamic>.from(m['my_voice_info'] as Map);
  }

  /// A Decide choice answers the session that asked.
  void answer(String text, String? sessionKey) {
    if (sessionKey != null && sessionKey != activeSession) selectSession(sessionKey);
    conn.send({'t': 'text', 'text': text});
  }

  void _chime(String kind) {
    if (sounds) audio.chime(kind);
  }

  bool get recording => _ptt != null;

  /// The Mac's address in use now (home Wi-Fi or Tailscale), while connected.
  String? get host => link == 'online' && info.hosts.isNotEmpty ? info.hosts.first : null;
  bool get viaTailscale {
    final m = RegExp(r'^100\.(\d+)\.').firstMatch(host ?? '');
    final b = m == null ? 0 : int.parse(m[1]!);
    return b >= 64 && b <= 127;
  }

  SessionStatus statusOf(String key) {
    final a = activity[key];
    final i = _seen[key] ?? const {};
    final pend = pending.values.where((p) => p['sessionKey'] == key).toList();
    if (pend.isNotEmpty) return SessionStatus('needs', 'Needs your OK', '${pend.first['tool_name']}: ${pend.first['description']}');
    if (state == 'speaking' && _lastSpeakKey == key) return SessionStatus('speaking', 'Speaking', i['reply'] as String? ?? '');
    final steps = ((a?['steps'] as List?) ?? const []).cast<Map>();
    if (a?['busy'] == true) {
      final cur = steps.reversed.where((s) => s['endedAt'] == null).firstOrNull;
      return SessionStatus('working', 'Working', cur?['label'] as String? ?? 'Thinking…');
    }
    final userAt = (i['userAt'] as num?) ?? 0;
    final replyAt = (i['replyAt'] as num?) ?? 0;
    if (((i['showAt'] as num?) ?? 0) > userAt && RegExp(r'\[!DECIDE\]', caseSensitive: false).hasMatch(i['show'] as String? ?? '')) {
      return SessionStatus('ask', 'Waiting for your answer', i['reply'] as String? ?? 'Claude asked you something');
    }
    final lastEnd = steps.fold<num>((a?['since'] as num?) ?? 0, (m, s) => ((s['endedAt'] as num?) ?? 0) > m ? s['endedAt'] as num : m);
    if (steps.isNotEmpty && DateTime.now().millisecondsSinceEpoch - lastEnd < 30 * 60000 && replyAt >= userAt) {
      return SessionStatus('done', 'Done · reply ready', i['reply'] as String? ?? 'Finished');
    }
    return SessionStatus('idle', 'Idle', i['reply'] as String? ?? 'Waiting for you');
  }

  void _track(Map<String, dynamic> m) {
    final key = m['session_key'] as String?;
    if (key == null) return;
    final at = (m['at'] as num?) ?? DateTime.now().millisecondsSinceEpoch;
    final i = _seen.putIfAbsent(key, () => {});
    switch (m['t']) {
      case 'user':
        i['userAt'] = at;
      case 'reply':
        i['replyAt'] = at;
        i['reply'] = m['speak'];
        _lastSpeakKey = key;
      case 'show':
        i['showAt'] = at;
        i['show'] = m['markdown'];
    }
  }

  void setBargeIn(bool on) {
    bargeIn = on;
    if (listening) conn.send({'t': 'stream', 'on': true, 'barge_in': on});
    notifyListeners();
  }

  void sendText(String text) {
    final picture = pendingPicture;
    if (picture != null) {
      final ref = 'm${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
      sentPictures[ref] = picture;
      conn.send({'t': 'picture', 'data': base64Encode(picture), 'text': text.trim(), 'ref': ref});
      pendingPicture = null;
      notifyListeners();
      return;
    }
    if (text.trim().isEmpty) return;
    conn.send({'t': 'text', 'text': text.trim()});
  }

  /// A screenshot Claude sent: asked from the Mac once, then kept. null: it's gone or the Mac didn't answer.
  Future<Uint8List?> loadPicture(String id) {
    final have = claudePictures[id];
    if (have != null) return Future.value(have);
    final wait = _pictureWaits[id];
    if (wait != null) return wait.future;
    final c = _pictureWaits[id] = Completer<Uint8List?>();
    conn.send({'t': 'picture_load', 'picture': id});
    Future.delayed(const Duration(seconds: 20), () {
      if (!c.isCompleted) {
        _pictureWaits.remove(id);
        c.complete(null);
      }
    });
    return c.future;
  }

  void approve(String requestId, bool allow) => conn.send({'t': 'approval', 'request_id': requestId, 'behavior': allow ? 'allow' : 'deny'});

  /// Pick option [choice] of a menu Claude Code shows in a terminal.
  void answerMenu(String requestId, int choice) => conn.send({'t': 'menu_answer', 'request_id': requestId, 'choice': choice});

  void setMode(String m) => conn.send({'t': 'mode', 'mode': m});

  void stopSpeaking() {
    audio.stopPlayback();
    conn.send({'t': 'stop_speaking'});
  }

  void selectSession(String key) => conn.send({'t': 'select_session', 'key': key});

  /// Start claude-voice in a listed folder on the Mac, in a hidden terminal (tmux):
  /// a new chat, or a past one by its id, with the profile picked (else the folder's own).
  void startSession(String cwd, {String? chat, String? profile}) =>
      conn.send({'t': 'start_session', 'cwd': cwd, 'chat': ?chat, 'profile': ?profile});

  /// Fresh lists of recent folders and workspaces.
  void browse() => conn.send({'t': 'browse'});

  /// Past chats in a folder, from the profile given (else the folder's own; the reply says which).
  void loadChats(String cwd, {String? profile}) {
    chats.remove(cwd);
    conn.send({'t': 'chats', 'cwd': cwd, 'profile': ?profile});
    notifyListeners();
  }

  /// Only for sessions the phone started.
  void endSession(String key) => conn.send({'t': 'end_session', 'key': key});

  /// Only for sessions the phone started: the Mac types /rename into it.
  /// Esc in a session the phone started: Claude stops what it's doing.
  void interruptSession(String key) => conn.send({'t': 'interrupt_session', 'key': key});
  void renameSession(String key, String name) => conn.send({'t': 'rename_session', 'key': key, 'name': name});

  void forgetProject(String cwd) => conn.send({'t': 'forget_project', 'cwd': cwd});

  /// Hear a reply again, on this phone only (the daemon keeps recent replies' audio in memory).
  void replay(String sayId) => conn.send({'t': 'replay', 'say_id': sayId});

  // --- from the daemon ----------------------------------------------------------------

  void _onLink(String s) {
    link = s;
    if (s == 'online' && listening) conn.send({'t': 'stream', 'on': true, 'barge_in': bargeIn});
    notifyListeners();
    _updateNotification();
  }

  void _onMessage(Map<String, dynamic> m) {
    switch (m['t']) {
      case 'picture_data':
        final id = m['picture'] as String;
        final data = m['data'] is String ? base64Decode(m['data'] as String) : null;
        if (data != null) claudePictures[id] = data;
        _pictureWaits.remove(id)?.complete(data);
        return;
      case 'welcome':
        _pins(m);
        items.clear();
        _seen.clear();
        pending.clear();
        menus.clear();
        _replaying = true;
        for (final h in (m['history'] as List)) {
          _render(Map<String, dynamic>.from(h as Map));
        }
        for (final p in (m['pending'] as List)) {
          _render({...Map<String, dynamic>.from(p as Map), 't': 'approval_request'});
        }
        for (final mm in (m['menus'] as List? ?? [])) {
          _render(Map<String, dynamic>.from(mm as Map));
        }
        _replaying = false;
        activity.clear();
        (m['activity'] as Map?)?.forEach((k, v) => activity[k as String] = Map<String, dynamic>.from(v as Map));
        state = m['state'] as String;
        _speech(m['speech_status'] as String? ?? 'on');
        _projects(m);
        mode = m['mode'] as String;
        passphraseSet = m['passphraseSet'] == true;
        if (m['wake'] != null) _wake(Map<String, dynamic>.from(m['wake'] as Map));
        fullDisk = m['full_disk'] as bool?;
        if (m['speak_all'] is bool) speakAll = m['speak_all'] as bool;
        _myVoice(m);
        _sessions(m);
      case 'state':
        state = m['state'] as String;
      case 'voice_config':
        if (m['speak_all'] is bool) speakAll = m['speak_all'] as bool;
        _myVoice(m);
      case 'speech':
        _speech(m['status'] as String);
      case 'projects':
        _projects(m);
      case 'browse':
        projects = ((m['recent'] as List?) ?? []).map((p) => Map<String, dynamic>.from(p as Map)).toList();
        workspaces = ((m['workspaces'] as List?) ?? []).map((w) => Map<String, dynamic>.from(w as Map)).toList();
        pinned = ((m['pinned'] as List?) ?? []).map((p) => Map<String, dynamic>.from(p as Map)).toList();
        profiles = ((m['profiles'] as List?) ?? []).cast<String>();
        fullDisk = m['full_disk'] as bool?;
      case 'chats':
        final cwd = m['cwd'] as String;
        chats[cwd] = ((m['chats'] as List?) ?? []).map((x) => Map<String, dynamic>.from(x as Map)).toList();
        if (m['profile'] is String) chatsProfile[cwd] = m['profile'] as String;
      case 'sessions':
        _sessions(m);
      case 'pins':
        _pins(m);
      case 'say_start':
        break;
      case 'wake':
        _wake(m);
      case 'not_for_claude':
        hint = 'Not sent to Claude. Start with “$wakePhrase”, or hold the mic.';
      case 'audio':
        audio.play(m['say_id'] as String, (m['seq'] as num).toInt(), base64Decode(m['pcm16'] as String));
        return; // no repaint per chunk
      case 'stop_playback':
        audio.stopPlayback();
      case 'resume_playback':
        audio.resume();
      case 'duck':
        audio.duck();
      case 'unduck':
        audio.unduck();
      case 'pause':
        audio.pause();
      case 'activity':
        final key = m['session'] as String;
        final wasBusy = activity[key]?['busy'] == true;
        activity[key] = m;
        if (wasBusy && m['busy'] != true && key == activeSession) _chime('done');
      case 'hearing':
        hearing = m['on'] == true;
        waiting = false;
        if (hearing) hint = 'Listening…';
      case 'wait':
        waiting = true;
        hint = 'Still listening… go on, take your time.';
      case 'heard':
        waiting = false;
        HapticFeedback.lightImpact();
        SystemSound.play(SystemSoundType.click);
        hint = 'Got it…';
      case 'transcript':
        final t = (m['text'] as String?) ?? '';
        hint = t.isEmpty ? "Didn't catch that." : 'Heard: “$t”';
      default:
        _render(m);
    }
    notifyListeners();
    _updateNotification();
  }

  void _pins(Map<String, dynamic> m) {
    pins = ((m['pins'] as List?) ?? []).map((p) => Map<String, dynamic>.from(p as Map)).toList();
  }

  void _projects(Map<String, dynamic> m) {
    projects = ((m['projects'] as List?) ?? []).map((p) => Map<String, dynamic>.from(p as Map)).toList();
  }

  void _sessions(Map<String, dynamic> m) {
    sessions = (m['sessions'] as List).map((s) => Map<String, dynamic>.from(s as Map)).toList();
    activeSession = m['active'] as String?;
  }

  void _render(Map<String, dynamic> m) {
    _track(m);
    switch (m['t']) {
      case 'user':
        items.add(Item(ItemKind.user, m['text'] as String, meta: m));
      case 'reply':
        if (m['kind'] == 'final') _lastFinal = m['speak'] as String;
        _lastSayId = m['say_id'] as String? ?? _lastSayId;
        items.add(Item(ItemKind.reply, m['speak'] as String, meta: m));
      case 'show':
        items.add(Item(ItemKind.detail, m['markdown'] as String, meta: m));
      case 'picture':
        items.add(Item(ItemKind.picture, m['caption'] as String? ?? '', meta: m));
      case 'approval_request':
        final id = m['request_id'] as String;
        if (pending.containsKey(id)) return;
        pending[id] = m;
        items.add(Item(ItemKind.approval, m['description'] as String, meta: m));
        if (!_replaying) _chime('approval');
      case 'approval_resolved':
        final id = m['request_id'] as String;
        pending.remove(id);
        for (final it in items.reversed) {
          if (it.kind == ItemKind.approval && it.meta['request_id'] == id) {
            it.resolution = m['via'] == 'terminal' ? 'Answered in the terminal' : '${m['behavior'] == 'allow' ? 'Approved' : 'Denied'} by ${m['via']}';
            break;
          }
        }
      case 'menu_request':
        final id = m['request_id'] as String;
        if (menus.containsKey(id)) return;
        menus[id] = m;
        items.add(Item(ItemKind.approval, m['title'] as String, meta: m));
        if (!_replaying) _chime('approval');
      case 'menu_resolved':
        final id = m['request_id'] as String;
        menus.remove(id);
        for (final it in items.reversed) {
          if (it.kind == ItemKind.approval && it.meta['request_id'] == id) {
            it.resolution = m['via'] == 'tap' ? 'Picked: ${m['label']}' : 'Answered in the terminal';
            break;
          }
        }
      case 'mode':
        mode = m['mode'] as String;
      case 'notice':
        items.add(Item(ItemKind.note, m['text'] as String));
      case 'command':
        items.add(Item(ItemKind.note, 'Voice command: ${(m['command'] as String).replaceAll('_', ' ')}'));
      case 'metrics':
        final parts = <String>[
          if (m['stt_ms'] != null) 'heard in ${m['stt_ms']} ms',
          if (m['claude_first_ms'] != null) 'Claude ${(m['claude_first_ms'] / 1000).toStringAsFixed(1)} s',
          if (m['tts_first_ms'] != null) 'voice ${m['tts_first_ms']} ms',
        ];
        items.add(Item(ItemKind.metrics, parts.join(' · '), meta: m));
    }
  }

  // --- from the native side -------------------------------------------------------------

  void _onAudioEvent(Map<String, dynamic> e) {
    switch (e['type']) {
      case 'pos':
        _pos = {'say_id': e['sayId'], 'seq': e['seq']};
        conn.send({'t': 'pos', 'say_id': e['sayId'], 'seq': e['seq']});
      case 'playing':
        _playing = e['on'] == true;
        conn.send({'t': 'playing', 'playing': _playing});
      case 'action':
        switch (e['action']) {
          case 'approve':
            approve(e['requestId'] as String, true);
          case 'deny':
            approve(e['requestId'] as String, false);
          case 'pause_listening':
            stopListening();
          case 'resume_listening':
            startListening();
          case 'stop_speaking':
            stopSpeaking();
          case 'replay':
            if (_lastSayId != null) replay(_lastSayId!);
        }
      case 'shared':
        checkShared();
    }
  }

  String get sessionLabel {
    final s = sessions.where((x) => x['key'] == activeSession).firstOrNull;
    return s?['label'] as String? ?? 'no session';
  }

  /// The step Claude is on, like "Editing app.js".
  String? _currentStep() {
    final steps = (currentActivity?['steps'] as List?) ?? const [];
    for (final s in steps.reversed) {
      if ((s as Map)['endedAt'] == null) return s['label'] as String?;
    }
    return null;
  }

  String? _lastStatus;
  void _updateNotification() {
    if (!_serviceStarted) return;
    final approval = pending.values.lastOrNull;
    final menu = menus.values.lastOrNull;
    final text = link != 'online'
        ? 'Reconnecting to ${info.name}…'
        : approval != null
            ? 'Approve: ${approval['description']}'
            : menu != null
            ? 'Asking: ${menu['title']}'
            : state == 'working' && currentActivity?['busy'] == true
                ? 'Working: ${_currentStep() ?? 'thinking'}'
                : state == 'idle' && _lastFinal.isNotEmpty
                    ? 'Done: $_lastFinal'
                    : '${stateText[state] ?? state}${listening ? '' : ' · mic paused'} · ${mode == 'tap' ? 'Tap mode' : 'Passphrase mode'}';
    final key = '$text|$listening|${approval?['request_id']}';
    if (key == _lastStatus) return;
    _lastStatus = key;
    audio.status(title: 'Handfree · $sessionLabel', text: text, listening: listening, approvalId: approval?['request_id'] as String?);
  }
}
