import 'package:flutter/services.dart';

/// Native audio engine + foreground service (see AudioEngine.kt, HandfreeService.kt).
class NativeAudio {
  static const _methods = MethodChannel('handfree/audio');
  static const _events = EventChannel('handfree/events');
  static const _mic = EventChannel('handfree/mic');

  /// pos {sayId, seq} · playing {on} · mic {on, aec} · action {action, requestId}
  Stream<Map<String, dynamic>> get events =>
      _events.receiveBroadcastStream().map((e) => Map<String, dynamic>.from(e as Map));

  /// 100 ms frames of 16 kHz mono PCM16 while the mic is on.
  Stream<Uint8List> get micFrames => _mic.receiveBroadcastStream().map((e) => e as Uint8List);

  Future<String> deviceName() async => await _methods.invokeMethod<String>('deviceName') ?? 'Android phone';
  Future<void> startService() => _methods.invokeMethod('startService');
  Future<void> stopService() => _methods.invokeMethod('stopService');
  Future<bool> startMic() async => await _methods.invokeMethod<bool>('startMic') ?? false;
  Future<void> stopMic() => _methods.invokeMethod('stopMic');
  Future<void> play(String sayId, int seq, Uint8List pcm) => _methods.invokeMethod('play', {'sayId': sayId, 'seq': seq, 'pcm': pcm});
  Future<void> stopPlayback() => _methods.invokeMethod('stopPlayback');
  Future<void> pause() => _methods.invokeMethod('pause');
  Future<void> resume() => _methods.invokeMethod('resume');
  Future<void> duck() => _methods.invokeMethod('duck');
  Future<void> unduck() => _methods.invokeMethod('unduck');

  /// Claude's voice at volume 0 on this phone; it still plays, so everything else works as usual.
  Future<void> setMuted(bool on) => _methods.invokeMethod('setMuted', {'muted': on});

  /// A picture shared to Handfree from another app (already shrunk to a JPEG), once; null if none.
  Future<Uint8List?> takeShared() => _methods.invokeMethod<Uint8List>('takeShared');

  /// 'done' or 'approval': a short tone plus vibration (works with the screen locked).
  Future<void> chime(String kind) => _methods.invokeMethod('chime', {'kind': kind});

  /// Updates the lock-screen notification.
  Future<void> status({required String title, required String text, required bool listening, String? approvalId}) =>
      _methods.invokeMethod('status', {'title': title, 'text': text, 'listening': listening, 'approvalId': approvalId});
}
