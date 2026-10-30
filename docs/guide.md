# Handfree AI: the full guide

Everything in detail: setup from zero, the optional extras, everyday use, the CLI and the config. The short version is in the [README](../README.md).

## How it fits together

```
 Android app ──wss (LAN, TLS, paired)──┐
 Web page ─────ws (localhost)──────────┤  handfree daemon ──local socket── channel shim ──MCP stdio── Claude Code (your terminal)
                                       │   ├─ speech sidecar (Python): Whisper STT, Qwen3/Kokoro TTS, Silero VAD
                                       │   ├─ approvals (tap / passphrase), voice commands, Stop-hook fallback
```

- **channel/**: the MCP channel shim, one per Claude Code session. Pushes your words in, gives Claude `reply` (speech) and `show` (detail), relays permission prompts.
- **daemon/**: the long-running daemon: clients, speech, approvals, pairing, sessions. The web page is in `daemon/public`.
- **speech/**: the Python sidecar: Whisper large-v3-turbo (whisper.cpp, Metal), Qwen3-TTS on Apple Silicon (Kokoro elsewhere), Silero VAD and Pipecat Smart Turn for the end of a turn.
- **app/**: the Flutter Android app, with an echo-cancelled audio engine and a foreground service for use with the screen locked.
- **whatsapp/**: an optional, read-only WhatsApp reader for Claude (see below).
- **scripts/**: `setup`, the `claude-voice` launcher and the `handfree` CLI.

## Requirements

- **macOS**. Apple Silicon gives the best voice (Qwen3-TTS); other Macs use Kokoro.
- **Claude Code v2.1.80 or newer**, logged in with a claude.ai account. Handfree uses Claude Code **channels**, a research preview: each launch shows a warning you confirm once.
- About **5 GB of disk** for the speech models, and about 4 GB of memory while voice is on.
- **Optional**: an Android phone, plus the Flutter SDK to build the app.

## Setup from zero

### 1. Install the tools

With [Homebrew](https://brew.sh):

```sh
brew install oven-sh/bun/bun uv ffmpeg openssl tmux
```

`tmux` is only needed to start sessions from the phone.

### 2. Install Claude Code and log in

Follow the [Claude Code setup](https://docs.claude.com/en/docs/claude-code/setup), then run `claude` once and log in with your claude.ai account.

### 3. Get Handfree and run the setup

```sh
git clone https://github.com/alvintom-dev/handfree-ai.git
cd handfree-ai
scripts/setup
```

`setup` is safe to re-run. It installs the packages, downloads about 1 GB of speech models into `~/.handfree/models`, and the browser libraries into `daemon/public/vendor`. The first voice start also downloads Qwen3-TTS (about 1.5 GB) into the Hugging Face cache.

Optional: put the scripts on your PATH, so you can type `claude-voice` and `handfree` anywhere:

```sh
echo "export PATH=\"$PWD/scripts:\$PATH\"" >> ~/.zshrc && source ~/.zshrc
```

### 4. Start your first voice session

```sh
cd ~/code/your-project
claude-voice
```

1. Claude Code shows a warning about development channels: pick **I am using this for local development**.
2. The voice page opens in your browser (http://127.0.0.1:8790). Allow the microphone, tap the mic, and talk.
3. Claude answers out loud, and longer details appear on the page.

Resume later from the same folder with `claude-voice --continue` or `claude-voice --resume`. The chat on the page comes back with the conversation.

### 5. Optional: the phone app (Android)

Build and install it ([Flutter SDK](https://docs.flutter.dev/get-started/install) needed):

```sh
cd app
flutter build apk --release        # app/build/app/outputs/flutter-apk/app-release.apk
adb install build/app/outputs/flutter-apk/app-release.apk   # or copy the file to the phone and open it
```

The build is signed with Flutter's debug key, which is fine for your own phone. Then pair it with the Mac:

```sh
handfree pair        # or "Pair a phone" on the web page
```

Scan the QR code in the app. The code works once, for 5 minutes. The phone must be on the same network as the Mac (or on Tailscale, step 7). It keeps working with the screen locked; the notification shows the status with Approve, Deny, Pause and Stop.

### 6. Optional: a Mac with no screen

```sh
handfree autostart on       # the daemon starts at login, and restarts if it crashes
handfree permissions        # once, at a screen: Full Disk Access for bun
```

Sessions you start from the phone run under the daemon, so macOS would otherwise stop them at a permission pop-up ("bun would like to access…") until someone clicks at the Mac. `handfree permissions` opens **Privacy & Security → Full Disk Access**: add `~/.bun/bin/bun`, then restart the daemon (`handfree stop`; the next `claude-voice` or the login item starts it again). Do the first run with a screen attached, in case macOS asks for Local Network access.

### 7. Optional: away from home with Tailscale

Install [Tailscale](https://tailscale.com) on the Mac and the phone, add `"allowTailscale": true` to `~/.handfree/config.json`, restart the daemon, and pair (or reconnect) once at home. The phone remembers the Mac's addresses, including its Tailscale one.

### 8. Optional: let Claude read WhatsApp chats

`whatsapp/` is a **read-only** MCP server over the WhatsApp Mac app's local database. It never talks to WhatsApp and can't send, change or mark anything read. It sees **only the chats you allow**, and the list starts empty.

> Note: it reads the WhatsApp app's private database, which WhatsApp doesn't officially support, and your terminal needs Full Disk Access to read it. Use it on your own account only.

```sh
# allow a chat (group name, contact name or phone number); the list lives in ~/.handfree/whatsapp.json
uv run --project whatsapp whatsapp/server.py allow "Family"
uv run --project whatsapp whatsapp/server.py allowed      # show the list
uv run --project whatsapp whatsapp/server.py deny "Family" # remove one

# give it to Claude Code (user scope: every project)
claude mcp add whatsapp --scope user -- uv run --quiet --project "$PWD/whatsapp" "$PWD/whatsapp/server.py"
```

You can also copy `whatsapp/whatsapp.example.json` to `~/.handfree/whatsapp.json` and edit it by hand. A `whatsapp.json` inside the repo is ignored by git, so a real list is never committed.

## Everyday use

- **Claude profiles**: `claude-voice` uses whatever `CLAUDE_CONFIG_DIR` your shell has. `--which-claude=default` uses `~/.claude`, and `--which-claude=<name>` uses `~/.claude-<name>` (for example `personal`).
- **Several sessions**: start `claude-voice` in more folders. Each session has its own chat; say "switch to web app", or pick it on the page or phone.
- **Voice on and off**: the daemon starts with voice off (about 130 MB). The speech models (about 4 GB) load when you tap **Start voice** or start `claude-voice`, and unload after `voiceIdleMin` minutes of quiet (default 30), never while Claude works. With voice off you can still type, and replies show as text.
- **Wake phrase**: in hands-free mode, start with "Hey Claude" (Settings). A sentence that follows your last one within a few seconds (`continueMs`) needs no phrase.
- **Mute**: **Mute voice here** (web) or the speaker button (phone) silences Claude on that device only.
- **Pictures**: 📎, paste or drop on the web page; the picture button or **Share → Handfree** on the phone. Kept in memory only (the last 20, for an hour). Claude can also show you screenshots.
- **Pins**: 📌 on any message keeps it in the session's Pinned column (web) or pinned bar (phone).
- **Copy**: every reply, detail and code block has a copy button; a detail copies as markdown.
- **Language**: **Settings → Language**: English, Rojak (Malaysian Malay and English mixed) or Auto. Replies are spoken in English. Notes on Malay reply voices: [docs/voice-research.md](voice-research.md).
- **Start a session from the phone**: tap **+**, pick a folder (Pinned, Recent, or a workspace from the config), a Claude profile, then a new or past chat. It runs in a hidden tmux session `hf-<folder>`; at the Mac, `tmux attach -t hf-<folder>`.

## CLI

```sh
handfree status | open | stop
handfree voice on | off                 # load / unload the speech models for every device
handfree set-passphrase                 # spoken approvals
handfree pair | devices | revoke <id>   # phones
handfree autostart on | off | status    # start the daemon at login (macOS)
handfree permissions                    # check Full Disk Access; opens the setting if not
```

## Config

`~/.handfree/config.json` is created on demand. Restart the daemon after editing it (`handfree stop`; the next `claude-voice` starts it again).

| Key | What it does |
|---|---|
| `language` | `en` \| `rojak` \| `auto` (see Language) |
| `vocabulary` | extra words Whisper should expect; unusual names from the session's project are added automatically |
| `voice`, `voiceStyle`, `speed`, `ttsEngine` | the reply voice (qwen3: aiden, ryan, serena, vivian; `ttsEngine`: auto \| qwen3 \| kokoro) |
| `voiceIdleMin` | minutes of quiet before voice turns itself off (0 = never) |
| `wakeWord`, `wakePhrase` | the hands-free wake phrase (default on, "Hey Claude") |
| `maxPauseMs`, `pauseMs`, `joinMs`, `longJoinMs`, `continueMs` | timing: how long a pause ends a turn, and when the next sentence joins the same message |
| `workspaces` | folders of projects the phone can start sessions in, each with a Claude profile, e.g. `[{"path": "~/work", "profile": "default"}, {"path": "~/code/side-projects", "profile": "personal"}]` |
| `pinned` | your own list for the phone's Pinned tab, e.g. `[{"path": "~/code/side-projects", "profile": "personal"}]` |
| `profiles` | the Claude profiles the phone can pick, e.g. `["default", "personal"]`; empty: the ones `workspaces` and `pinned` name |
| `port`, `lanPort`, `allowTailscale` | the web page port (8790), the phone port (8791), and Tailscale addresses for phones |

## Tests

```sh
bun test                          # everything below, from the repo root
(cd channel && bun test)          # the shim against a fake daemon
(cd daemon && bun test)           # units + end to end with the real speech models (macOS `say` speaks the input)
(cd app && flutter test)
```

Tests run in a temporary folder and never touch your own `~/.handfree`.

## Privacy and security

- Audio streams through memory only and is never written to disk. The record of what you said is the text in the Claude Code session.
- Everything personal lives in `~/.handfree` with owner-only permissions: the secret, passphrase hash, device tokens (hashed), TLS key, settings, chat, pins and voiceprint. Nothing of it is in this repo.
- The web page listens on 127.0.0.1 only. Phones connect over TLS on your local network (or Tailscale, if you turn it on), after pairing with a one-time code.
- Pictures are kept in memory only, for an hour.

## Licence

[MIT](../LICENSE)
