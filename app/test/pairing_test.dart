import 'package:flutter_test/flutter_test.dart';
import 'package:handfree/pairing.dart';

void main() {
  const fp = 'a3f1c2d4e5b6a7980112233445566778899aabbccddeeff00112233445566778';

  test('parses the QR from handfree pair', () {
    final i = PairInfo.fromUrl('handfree://pair?h=192.168.1.5,10.0.0.2&p=8791&c=GKD73CU3&f=$fp&n=My%20Mac')!;
    expect(i.hosts, ['192.168.1.5', '10.0.0.2']);
    expect(i.port, 8791);
    expect(i.code, 'GKD73CU3');
    expect(i.fingerprint, fp);
    expect(i.paired, isFalse);
  });

  test('rejects anything that is not a complete handfree pairing code', () {
    expect(PairInfo.fromUrl('https://example.com'), isNull);
    expect(PairInfo.fromUrl('handfree://pair?h=1.2.3.4&p=8791&c=X&f=nothex'), isNull);
    expect(PairInfo.fromUrl('handfree://pair?p=8791&c=X&f=$fp'), isNull);
  });

  test('round-trips through storage without the one-time code', () {
    final i = PairInfo.fromUrl('handfree://pair?h=192.168.1.5&p=8791&c=GKD73CU3&f=$fp')!..token = 't0k3n';
    final back = PairInfo.fromJson(i.toJson());
    expect(back.token, 't0k3n');
    expect(back.code, isNull);
    expect(back.hosts, ['192.168.1.5']);
  });
}
