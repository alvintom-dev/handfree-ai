import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:nsd/nsd.dart' as nsd;

import 'audio.dart';
import 'pairing.dart';

/// TLS WebSocket to the daemon with the certificate pinned by fingerprint.
/// Reconnects with backoff; if every known address fails, asks mDNS where the
/// Mac went (DHCP may have moved it).
class Connection {
  Connection(this.info, {required this.onMessage, required this.onStatus, required this.onPaired});

  final PairInfo info;
  final void Function(Map<String, dynamic> msg) onMessage;
  final void Function(String status) onStatus;
  final void Function(PairInfo info) onPaired;

  WebSocket? _ws;
  bool _closed = false;
  int _attempt = 0;
  Timer? _ping;

  bool get connected => _ws?.readyState == WebSocket.open;

  void start() => _loop();

  Future<void> close() async {
    _closed = true;
    _ping?.cancel();
    await _ws?.close();
  }

  void send(Map<String, dynamic> msg) {
    if (connected) _ws!.add(jsonEncode(msg));
  }

  void sendAudio(Uint8List frame) {
    if (connected) _ws!.add(frame);
  }

  Future<void> _loop() async {
    while (!_closed) {
      onStatus(_attempt == 0 ? 'connecting' : 'reconnecting');
      var ok = false;
      for (final host in List<String>.from(info.hosts)) {
        if (await _connect(host)) {
          ok = true;
          // remember the address that worked
          info.hosts
            ..remove(host)
            ..insert(0, host);
          break;
        }
      }
      if (!ok && await _discover()) continue;
      if (ok) {
        _attempt = 0;
        await _ws!.done;
        _ping?.cancel();
        if (_ws?.closeCode == 4003) {
          onStatus('unauthorized');
          return; // token revoked or code used: needs re-pairing
        }
      }
      if (_closed) return;
      _attempt++;
      onStatus('offline');
      await Future<void>.delayed(Duration(milliseconds: (500 * (1 << _attempt.clamp(0, 4))).clamp(500, 8000)));
    }
  }

  Future<bool> _connect(String host) async {
    String? seenFp;
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 4)
      ..badCertificateCallback = (cert, h, port) {
        // self-signed by design: trust exactly the pinned certificate
        seenFp = sha256.convert(cert.der).toString();
        return info.fingerprint.isEmpty || seenFp == info.fingerprint;
      };
    try {
      final ws = await WebSocket.connect('wss://$host:${info.port}/ws', customClient: client).timeout(const Duration(seconds: 6));
      _ws = ws;
      ws.pingInterval = const Duration(seconds: 20);
      if (info.fingerprint.isEmpty && seenFp != null) info.fingerprint = seenFp!; // trust on first use
      if (info.paired) {
        ws.add(jsonEncode({'t': 'hello', 'token': info.token, 'client': 'android'}));
      } else {
        ws.add(jsonEncode({'t': 'pair', 'code': info.code, 'name': await _deviceName()}));
      }
      ws.listen((data) {
        if (data is String) {
          final msg = jsonDecode(data) as Map<String, dynamic>;
          if (msg['t'] == 'welcome') {
            final paired = msg['paired'] as Map<String, dynamic>?;
            if (paired != null) {
              info.token = paired['token'] as String;
              info.code = null;
              onPaired(info);
            }
            if (_learnHosts(msg['hosts'])) onPaired(info);
            onStatus('online');
          }
          onMessage(msg);
        }
      }, onDone: () {}, onError: (_) {});
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Adds the Mac's other addresses (such as Tailscale's) after the ones we
  /// know, so the phone can still reach it away from home. True if any were new.
  bool _learnHosts(Object? hosts) {
    if (hosts is! List) return false;
    var added = false;
    for (final h in hosts.whereType<String>()) {
      if (!info.hosts.contains(h)) {
        info.hosts.add(h);
        added = true;
      }
    }
    return added;
  }

  /// mDNS: find a handfree daemon whose certificate matches ours.
  Future<bool> _discover() async {
    if (info.fingerprint.isEmpty) return false;
    nsd.Discovery? discovery;
    try {
      discovery = await nsd.startDiscovery('_handfree._tcp', ipLookupType: nsd.IpLookupType.v4);
      final found = Completer<String?>();
      void check() {
        for (final s in discovery!.services) {
          final fp = s.txt?['fp'];
          final fpText = fp == null ? '' : utf8.decode(fp);
          if (fpText.isNotEmpty && info.fingerprint.startsWith(fpText)) {
            final ip = s.addresses?.firstOrNull?.address;
            if (ip != null && !found.isCompleted) found.complete(ip);
          }
        }
      }
      discovery.addListener(check);
      final ip = await found.future.timeout(const Duration(seconds: 4), onTimeout: () => null);
      if (ip != null && !info.hosts.contains(ip)) {
        info.hosts.insert(0, ip);
        onPaired(info);
        return true;
      }
    } catch (_) {
      // mDNS unavailable on this network
    } finally {
      if (discovery != null) await nsd.stopDiscovery(discovery);
    }
    return false;
  }

  Future<String> _deviceName() async {
    try {
      return await NativeAudio().deviceName();
    } catch (_) {
      return 'Android phone';
    }
  }
}
