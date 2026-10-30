import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the Mac is, which certificate to trust, and this phone's device token.
class PairInfo {
  PairInfo({required this.hosts, required this.port, required this.fingerprint, this.token, this.name = 'Mac', this.code});

  /// LAN addresses to try, best first. Updated when mDNS finds the Mac elsewhere.
  List<String> hosts;
  int port;

  /// SHA-256 of the daemon's certificate (hex). Empty until first use for
  /// manually entered pairings; pinned from then on.
  String fingerprint;
  String? token;
  String name;

  /// One-time pairing code, only until the daemon hands out a token.
  String? code;

  bool get paired => token != null && token!.isNotEmpty;

  /// `handfree://pair?h=192.168.1.5,10.0.0.2&p=8791&c=ABCD2345&f=SHA256&n=MAC_NAME`
  static PairInfo? fromUrl(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || uri.scheme != 'handfree' || uri.host != 'pair') return null;
    final q = uri.queryParameters;
    final hosts = (q['h'] ?? '').split(',').where((h) => h.isNotEmpty).toList();
    final port = int.tryParse(q['p'] ?? '');
    final code = q['c'];
    final fp = (q['f'] ?? '').toLowerCase();
    if (hosts.isEmpty || port == null || code == null || !RegExp(r'^[0-9a-f]{64}$').hasMatch(fp)) return null;
    return PairInfo(hosts: hosts, port: port, fingerprint: fp, code: code, name: q['n'] ?? 'Mac');
  }

  Map<String, dynamic> toJson() => {'hosts': hosts, 'port': port, 'fingerprint': fingerprint, 'token': token, 'name': name};

  static PairInfo fromJson(Map<String, dynamic> j) => PairInfo(
        hosts: List<String>.from(j['hosts'] as List),
        port: j['port'] as int,
        fingerprint: j['fingerprint'] as String,
        token: j['token'] as String?,
        name: j['name'] as String? ?? 'Mac',
      );
}

class PairStore {
  static const _key = 'handfree.pairing';
  final _storage = const FlutterSecureStorage();

  Future<PairInfo?> load() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return PairInfo.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(PairInfo info) => _storage.write(key: _key, value: jsonEncode(info.toJson()));

  Future<void> clear() => _storage.delete(key: _key);
}
