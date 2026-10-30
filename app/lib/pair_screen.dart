import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'pairing.dart';

/// First run: scan the QR from `handfree pair` (or the web page), or type the code.
class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.onPaired});
  final void Function(PairInfo info) onPaired;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  bool manual = false;
  bool done = false;
  final host = TextEditingController();
  final port = TextEditingController(text: '8791');
  final code = TextEditingController();
  String? error;

  void _use(PairInfo info) {
    if (done) return;
    done = true;
    // the token arrives on first connect; HomeScreen saves it
    widget.onPaired(info);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Pair with your Mac')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('On your Mac, run  handfree pair  or click “Pair a phone” on the Handfree page. Then scan the code.',
                style: t.textTheme.bodyLarge),
            const SizedBox(height: 16),
            if (!manual)
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: SizedBox(
                  height: 320,
                  child: MobileScanner(
                    onDetect: (capture) {
                      for (final b in capture.barcodes) {
                        final info = PairInfo.fromUrl(b.rawValue ?? '');
                        if (info != null) return _use(info);
                      }
                      setState(() => error = 'That QR code is not a Handfree pairing code.');
                    },
                  ),
                ),
              )
            else ...[
              TextField(controller: host, decoration: const InputDecoration(labelText: 'Mac address (e.g. 192.168.1.5)', border: OutlineInputBorder()), keyboardType: TextInputType.url),
              const SizedBox(height: 12),
              TextField(controller: port, decoration: const InputDecoration(labelText: 'Port', border: OutlineInputBorder()), keyboardType: TextInputType.number),
              const SizedBox(height: 12),
              TextField(controller: code, decoration: const InputDecoration(labelText: 'Pairing code (e.g. GKD7-3CU3)', border: OutlineInputBorder()), textCapitalization: TextCapitalization.characters),
              const SizedBox(height: 8),
              Text('Typed pairing trusts the Mac’s certificate on first connect, then pins it.', style: t.textTheme.bodySmall),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: () {
                  final p = int.tryParse(port.text.trim());
                  final c = code.text.trim().toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
                  if (host.text.trim().isEmpty || p == null || c.length != 8) {
                    return setState(() => error = 'Enter the address, port and 8-character code.');
                  }
                  _use(PairInfo(hosts: [host.text.trim()], port: p, fingerprint: '', code: c));
                },
                child: const Text('Pair'),
              ),
            ],
            if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: TextStyle(color: t.colorScheme.error))),
            const SizedBox(height: 12),
            TextButton(onPressed: () => setState(() => manual = !manual), child: Text(manual ? 'Scan a QR code instead' : 'Type the code instead')),
          ],
        ),
      ),
    );
  }
}
