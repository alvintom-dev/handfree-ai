import 'package:flutter/material.dart';

import 'home_screen.dart';
import 'pair_screen.dart';
import 'pairing.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const HandfreeApp());
}

class HandfreeApp extends StatefulWidget {
  const HandfreeApp({super.key});

  @override
  State<HandfreeApp> createState() => _HandfreeAppState();
}

class _HandfreeAppState extends State<HandfreeApp> {
  final store = PairStore();
  PairInfo? info;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    lookPrefs.addListener(_look);
    lookPrefs.load();
    store.load().then((i) => setState(() {
          info = i;
          loading = false;
        }));
  }

  void _look() => setState(() {});

  @override
  void dispose() {
    lookPrefs.removeListener(_look);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Handfree',
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: lookPrefs.mode,
      // Large text: the web's 17 px against 15 px
      builder: (context, child) => lookPrefs.large
          ? MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: MediaQuery.of(context).textScaler.clamp(minScaleFactor: 1.13)), child: child!)
          : child!,
      debugShowCheckedModeBanner: false,
      home: loading
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : info == null
              ? PairScreen(onPaired: (i) => setState(() => info = i))
              : HomeScreen(
                  key: ValueKey(info),
                  info: info!,
                  store: store,
                  onUnpair: () async {
                    await store.clear();
                    setState(() => info = null);
                  },
                ),
    );
  }
}
