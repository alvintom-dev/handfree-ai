# Voice research: replies in Malay and rojak

Notes for anyone who wants Claude's spoken replies in Malay or rojak. Listening already handles rojak (Settings → Language); the reply voice is still English.

Replies in rojak were clear but sounded "too English" with today's voice (Qwen3 TTS, which has no Malay). What was tried on 2026-10-29:

- **Chatterbox multilingual v3** (`mlx-community/chatterbox-multilingual-v3`, Resemble AI, MIT, 2.7 GB, already in the Hugging Face cache) speaks Malay (`lang_code="ms"`) in any voice copied from a short clip. Malay samples in Kokoro's deep male voices, as heard back by Whisper: **Fenrir** almost word for word (the best), George small slips, Onyx one wrong word. About 4 s to make a 9 s reply in one go; read sentence by sentence it should start in about 1.5 s (not measured). It has no built-in voice: it always needs a reference clip.
- **Mesolitica Malaysian-TTS 1.7B v1** (Qwen3-based, DistilCodec, about 2B params, no licence stated): 7 voices (husein, idayu, haqkiem, …) with Malay ↔ English switching. Needs its own engine (transformers + DistilCodec), not tried yet beyond its sample clips.
- **macOS Amira** (`say -v Amira`): free and instant, but robotic.

Next steps: add Chatterbox to the speech sidecar as a TTS engine that reads sentence by sentence with a reference clip (e.g. a Kokoro `am_fenrir` clip); measure the time to the first word (keep it only if it's 2 s or less); add a Voice choice in Settings; with Rojak on, tell sessions to reply in rojak.
