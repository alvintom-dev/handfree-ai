"""Handfree speech sidecar: local speech-to-text and text-to-speech.

The daemon runs this as a child process and talks to it over stdin/stdout,
one JSON object per line. Audio travels as base64 PCM16 mono.

Requests (stdin):
  {"op": "stt", "id": str, "pcm16": b64, "rate": 16000, "prompt"?: str, "language"?: str, "voice"?: bool}
  {"op": "tts", "id": str, "text": str, "voice"?: str, "speed"?: float}
  {"op": "tts_cancel", "id": str}
  {"op": "vad_audio", "stream": str, "pcm16": b64}   raw mic audio from a streaming client
  {"op": "vad_reset", "stream": str}
  {"op": "ping"}

Events (stdout):
  {"op": "ready", "stt": str, "tts": str, "load_ms": int}
  {"op": "stt", "id", "text", "ms", "voice"?: {"emb", "level_db", "snr_db", "secs"}}   voice: asked for, and the model is there
  {"op": "tts_chunk", "id", "seq", "pcm16", "rate", "text"}   one per sentence
  {"op": "tts_done", "id", "first_ms", "total_ms", "cancelled"}
  {"op": "vad", "stream", "event": "start" | "misfire" | "end", "pcm16"?}  (end carries the utterance)
  {"op": "error", "id"?, "message"}
  {"op": "pong"}

Nothing is written to disk. Engines sit behind small classes so another OS can
swap them without touching the daemon.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np

MODELS = Path(os.environ.get("HANDFREE_MODELS", Path.home() / ".handfree" / "models"))
STT_MODEL = os.environ.get("HANDFREE_STT_MODEL", "ggml-large-v3-turbo-q8_0.bin")
STT_BEAM = int(os.environ.get("HANDFREE_STT_BEAM", "5"))  # 1 = greedy; 5 costs ~30 ms and halves slips
STT_LANGUAGE = os.environ.get("HANDFREE_STT_LANGUAGE", "en")
TTS_MODEL = os.environ.get("HANDFREE_TTS_MODEL", "kokoro-v1.0.onnx")
TTS_VOICES = os.environ.get("HANDFREE_TTS_VOICES", "voices-v1.0.bin")
VAD_MODEL = os.environ.get("HANDFREE_VAD_MODEL", "silero_vad_v5.onnx")
TTS_ENGINE = os.environ.get("HANDFREE_TTS_ENGINE", "auto")  # auto | qwen3 | kokoro
QWEN3_REPO = os.environ.get("HANDFREE_QWEN3_REPO", "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit")
VOICE_STYLE = os.environ.get(
    "HANDFREE_VOICE_STYLE",
    "Relaxed, warm and conversational, like explaining something to a colleague sitting next to you.",
)
DEFAULT_VOICE = os.environ.get("HANDFREE_VOICE", "")  # empty: the engine's own default
PAUSE_MS = int(os.environ.get("HANDFREE_PAUSE_MS", "1200"))  # a pause this long ends the turn (no turn model)
TURN_MODEL = os.environ.get("HANDFREE_TURN_MODEL", "smart-turn-v3.2-cpu.onnx")
SPEAKER_MODEL = os.environ.get("HANDFREE_SPEAKER_MODEL", "wespeaker_resnet34.onnx")  # "my voice only"
MAX_PAUSE_MS = int(os.environ.get("HANDFREE_MAX_PAUSE_MS", "3000"))  # with the turn model: longest wait mid-thought

_out_lock = threading.Lock()

# The protocol owns the real stdout. Libraries (mlx-audio, transformers,
# whisper.cpp) print status lines, so point fd 1 at stderr and keep a private
# handle on the original for our JSON.
_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(event: dict) -> None:
    line = json.dumps(event, separators=(",", ":"))
    with _out_lock:
        _proto.write(line + "\n")
        _proto.flush()


def log(msg: str) -> None:
    print(f"[speech] {msg}", file=sys.stderr, flush=True)


# --- engines ----------------------------------------------------------------------


class WhisperCppStt:
    name = "whisper.cpp"

    def __init__(self) -> None:
        from pywhispercpp.model import Model

        path = MODELS / STT_MODEL
        self.model = Model(
            str(path),
            params_sampling_strategy=1 if STT_BEAM > 1 else 0,
            print_progress=False,
            print_realtime=False,
            redirect_whispercpp_logs_to=False,
        )
        self.label = f"{self.name}:{path.name}"

    def transcribe(self, audio: np.ndarray, prompt: str | None, language: str | None = None) -> str:
        kwargs = {"language": language or STT_LANGUAGE, "no_context": True, "single_segment": False}
        if STT_BEAM > 1:
            kwargs["beam_search"] = {"beam_size": STT_BEAM, "patience": -1.0}
        if prompt:
            kwargs["initial_prompt"] = prompt
        segments = self.model.transcribe(audio, **kwargs)
        text = " ".join(s.text.strip() for s in segments).strip()
        # whisper marks silence/noise like "[BLANK_AUDIO]" or "(wind blowing)"
        text = re.sub(r"\[[^\]]*\]|\([^)]*\)", "", text).strip()
        # the prompt mentions Claude, and Whisper sometimes echoes it as a speaker label
        return re.sub(r"^claude( said)?:\s*", "", text, flags=re.I)


class KokoroTts:
    """Portable CPU voice (ONNX). Runs anywhere, including Windows."""

    name = "kokoro"
    rate = 24000
    default_voice = "af_heart"

    def __init__(self) -> None:
        from kokoro_onnx import Kokoro

        self.model = Kokoro(str(MODELS / TTS_MODEL), str(MODELS / TTS_VOICES))
        self.voices = set(self.model.get_voices())
        self.label = f"{self.name}:{TTS_MODEL}"

    def synthesize(self, text: str, voice: str, speed: float) -> np.ndarray:
        voice = voice if voice in self.voices else self.default_voice
        samples, _ = self.model.create(text, voice=voice, speed=speed, lang="en-us")
        return samples


class Qwen3MlxTts:
    """Apple Silicon GPU voice: more natural, about 0.2 s to the first sentence."""

    name = "qwen3"
    rate = 24000
    default_voice = "aiden"
    voices = {"ryan", "aiden", "serena", "vivian"}

    def __init__(self) -> None:
        from mlx_audio.tts.utils import load_model

        self.repo = QWEN3_REPO
        self.model = load_model(self.repo)
        self.rate = getattr(self.model, "sample_rate", 24000)
        self.label = f"{self.name}:{self.repo.split('/')[-1]}"

    def synthesize(self, text: str, voice: str, speed: float) -> np.ndarray:
        voice = voice if voice in self.voices else self.default_voice
        parts = [
            np.array(r.audio, dtype=np.float32).reshape(-1)
            for r in self.model.generate(text=text, voice=voice, instruct=VOICE_STYLE or None, speed=speed, lang_code="english")
        ]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def make_tts():
    engine = TTS_ENGINE
    if engine == "auto":
        try:
            import mlx_audio  # noqa: F401  (Apple Silicon only)

            engine = "qwen3"
        except ImportError:
            engine = "kokoro"
    if engine == "qwen3":
        try:
            return Qwen3MlxTts()
        except Exception as e:  # model missing or no GPU: fall back rather than go mute
            log(f"qwen3 unavailable ({e}); falling back to kokoro")
    return KokoroTts()


class SmartTurn:
    """Has the speaker finished their thought? Pipecat's Smart Turn v3 hears tone
    and rhythm, not words: 8 MB ONNX on the CPU, about 20 ms per check."""

    SECONDS = 8

    def __init__(self) -> None:
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(MODELS / TURN_MODEL), sess_options=opts, providers=["CPUExecutionProvider"])
        self.features = WhisperFeatureExtractor(chunk_length=self.SECONDS)

    def finished(self, audio: np.ndarray) -> float:
        """Probability the turn is complete, from the whole turn so far."""
        n = self.SECONDS * 16000
        audio = audio[-n:]
        audio = np.pad(audio, (n - len(audio), 0))  # the model wants speech at the end
        f = self.features(audio, sampling_rate=16000, return_tensors="np", padding="max_length",
                          max_length=n, truncation=True, do_normalize=True).input_features.astype(np.float32)
        return float(self.session.run(None, {"input_features": f})[0].reshape(-1)[0])


def load_turn_model() -> SmartTurn | None:
    if not (MODELS / TURN_MODEL).exists():
        log(f"no {TURN_MODEL}: turns end after a {PAUSE_MS} ms pause")
        return None
    try:
        return SmartTurn()
    except Exception as e:  # missing transformers etc.: plain pause rule
        log(f"turn model unavailable ({e}): turns end after a {PAUSE_MS} ms pause")
        return None


class SileroVad:
    """Streaming voice activity detection for clients that send raw mic audio.

    32 ms frames; short blips are misfires. With the turn model, a short pause
    asks it whether you're done; without it, a pause of `redemption` ends the turn.
    """

    FRAME = 512  # samples at 16 kHz
    CONTEXT = 64

    def __init__(self) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(MODELS / VAD_MODEL), sess_options=opts, providers=["CPUExecutionProvider"])
        self.sr = np.array(16000, dtype=np.int64)

    turn: SmartTurn | None = None

    def new_stream(self) -> "VadStream":
        return VadStream(self)

    def prob(self, frame: np.ndarray, st: "VadStream") -> float:
        x = np.concatenate([st.context, frame])[None, :].astype(np.float32)
        out, st.state = self.session.run(None, {"input": x, "state": st.state, "sr": self.sr})
        st.context = frame[-self.CONTEXT:]
        return float(out[0][0])


class VadStream:
    POSITIVE, NEGATIVE = 0.5, 0.35
    REDEMPTION = max(1, round(PAUSE_MS / 32))  # frames of quiet that end the turn
    CHECK = 10  # frames (~320 ms) of quiet before asking the turn model
    MAX_QUIET = max(CHECK + 1, round(MAX_PAUSE_MS / 32))  # mid-thought, but this quiet ends it anyway
    PRE_PAD, MIN_SPEECH = 10, 8  # frames: ~320 ms, ~256 ms

    def __init__(self, vad: SileroVad) -> None:
        self.vad = vad
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(SileroVad.CONTEXT, dtype=np.float32)
        self.pending = np.zeros(0, dtype=np.float32)
        self.pre: list[np.ndarray] = []
        self.speech: list[np.ndarray] = []
        self.speaking = False
        self.quiet = 0
        self.voiced = 0
        self.checked = False  # asked the turn model during this pause
        self.how = ""  # why the last turn ended: "turn" (model said done), "max" or "pause"

    def feed(self, samples: np.ndarray) -> list[tuple[str, np.ndarray | None]]:
        """Returns events: ("start", None), ("misfire", None), ("wait", None) when
        the turn model hears you mid-thought, and ("end", audio)."""
        events: list[tuple[str, np.ndarray | None]] = []
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= SileroVad.FRAME:
            frame, self.pending = self.pending[: SileroVad.FRAME], self.pending[SileroVad.FRAME:]
            p = self.vad.prob(frame, self)
            if not self.speaking:
                self.pre = (self.pre + [frame])[-self.PRE_PAD:]
                if p >= self.POSITIVE:
                    self.speaking, self.quiet, self.voiced = True, 0, 1
                    self.speech = list(self.pre)
                    events.append(("start", None))
                continue
            self.speech.append(frame)
            if p >= self.POSITIVE:
                self.quiet = 0
                self.voiced += 1
                self.checked = False
            elif p < self.NEGATIVE:
                self.quiet += 1
                turn = self.vad.turn
                if turn is None:
                    if self.quiet >= self.REDEMPTION:
                        self.finish(events, "pause")
                elif self.voiced < self.MIN_SPEECH:
                    if self.quiet >= self.CHECK:  # a blip, not a turn
                        self.finish(events, "pause")
                elif self.quiet == self.CHECK and not self.checked:
                    self.checked = True
                    if turn.finished(np.concatenate(self.speech)) >= 0.5:
                        self.finish(events, "turn")
                    else:
                        events.append(("wait", None))
                elif self.quiet >= self.MAX_QUIET:
                    self.finish(events, "max")
        return events

    def finish(self, events: list, how: str) -> None:
        audio = np.concatenate(self.speech[: len(self.speech) - self.quiet + 3])
        self.how = how
        events.append(("end", audio) if self.voiced >= self.MIN_SPEECH else ("misfire", None))
        self.speaking, self.speech, self.pre, self.checked = False, [], [], False


def trim_tail(vad: SileroVad, audio: np.ndarray, keep: int = 4800) -> np.ndarray:
    """Cut the quiet after your last word (keeping 0.3 s). The turn-ending pause
    is otherwise sent along, and Whisper likes to invent words ("Thank you.") in it."""
    st = vad.new_stream()
    last = -1
    for i in range(len(audio) // SileroVad.FRAME):
        if vad.prob(audio[i * SileroVad.FRAME : (i + 1) * SileroVad.FRAME], st) >= VadStream.POSITIVE:
            last = i
    return audio if last < 0 else audio[: (last + 1) * SileroVad.FRAME + keep]


# --- helpers --------------------------------------------------------------------

_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])")


def sentences(text: str) -> list[str]:
    """Split for streaming: first audio comes from the first sentence alone."""
    parts = [p.strip() for p in _SENTENCE.split(text.strip()) if p.strip()]
    # a long first sentence is cut at its first comma: time to first audio grows with length
    if parts and len(parts[0]) > 70:
        cut = parts[0].find(", ", 15)
        if 0 < cut < 60:
            parts[0:1] = [parts[0][: cut + 1], parts[0][cut + 2 :]]
    # the first sentence goes alone so audio starts fast; later tiny ones merge
    # with their neighbour, which keeps the prosody natural
    out: list[str] = []
    for p in parts:
        if len(out) > 1 and len(out[-1]) < 20:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return out


def pcm16_to_float(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(samples: np.ndarray) -> str:
    clipped = np.clip(samples, -1.0, 1.0)
    return base64.b64encode((clipped * 32767).astype("<i2").tobytes()).decode()


# --- workers --------------------------------------------------------------------


class VoiceFeatures:
    """For "my voice only": who spoke (a speaker embedding, compared with your voiceprint by
    the daemon) and how loud, against the clip's own quiet parts. ~20 ms per utterance."""

    def __init__(self) -> None:
        import sherpa_onnx

        cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(MODELS / SPEAKER_MODEL), num_threads=1)
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def features(self, audio: np.ndarray) -> dict:
        st = self.extractor.create_stream()
        st.accept_waveform(16000, audio)
        st.input_finished()
        emb = np.asarray(self.extractor.compute(st), dtype=np.float32)
        emb /= np.linalg.norm(emb) or 1.0
        # 20 ms frames: the loudest 30% are the voice, the quietest 10% the room
        frames = audio[: len(audio) // 320 * 320].reshape(-1, 320)
        db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9) if len(frames) else np.array([-120.0])
        loud = float(np.sort(db)[-max(1, len(db) * 3 // 10):].mean())
        floor = float(np.percentile(db, 10))
        return {
            "emb": [round(float(x), 5) for x in emb],
            "level_db": round(loud, 1),
            "snr_db": round(loud - floor, 1),
            "secs": round(len(audio) / 16000, 2),
        }


def stt_worker(engine: WhisperCppStt, vad: SileroVad, jobs: queue.Queue) -> None:
    voice: VoiceFeatures | None = None
    while True:
        req = jobs.get()
        try:
            t0 = time.perf_counter()
            audio = pcm16_to_float(req["pcm16"])
            if req.get("rate", 16000) != 16000:
                raise ValueError("stt expects 16 kHz audio")
            audio = trim_tail(vad, audio)
            text = engine.transcribe(audio, req.get("prompt"), req.get("language"))
            ev = {"op": "stt", "id": req["id"], "text": text, "ms": round((time.perf_counter() - t0) * 1000)}
            if req.get("voice") and (MODELS / SPEAKER_MODEL).exists():
                try:
                    voice = voice or VoiceFeatures()  # loaded the first time it's asked for
                    ev["voice"] = voice.features(audio)
                except Exception as e:  # the transcript still goes out
                    log(f"voice features failed: {e}")
            emit(ev)
        except Exception as e:  # keep serving after a bad request
            emit({"op": "error", "id": req.get("id"), "message": f"stt: {e}"})


def tts_worker(engine, jobs: queue.Queue, cancelled: set) -> None:
    while True:
        req = jobs.get()
        rid = req["id"]
        t0 = time.perf_counter()
        first_ms = None
        was_cancelled = False
        try:
            for seq, sentence in enumerate(sentences(req["text"])):
                if rid in cancelled:
                    was_cancelled = True
                    break
                samples = engine.synthesize(sentence, req.get("voice") or DEFAULT_VOICE or engine.default_voice, float(req.get("speed", 1.0)))
                if rid in cancelled:
                    was_cancelled = True
                    break
                if first_ms is None:
                    first_ms = round((time.perf_counter() - t0) * 1000)
                emit({"op": "tts_chunk", "id": rid, "seq": seq, "pcm16": float_to_pcm16(samples), "rate": engine.rate, "text": sentence})
        except Exception as e:
            emit({"op": "error", "id": rid, "message": f"tts: {e}"})
        finally:
            cancelled.discard(rid)
            emit({"op": "tts_done", "id": rid, "first_ms": first_ms, "total_ms": round((time.perf_counter() - t0) * 1000), "cancelled": was_cancelled})


def main() -> None:
    t0 = time.perf_counter()
    stt = WhisperCppStt()
    tts = make_tts()
    # warm both models so the first real turn isn't slow
    stt.transcribe(np.zeros(16000, dtype=np.float32), None)
    tts.synthesize("Ready.", DEFAULT_VOICE or tts.default_voice, 1.0)
    emit({"op": "ready", "stt": stt.label, "tts": tts.label, "load_ms": round((time.perf_counter() - t0) * 1000)})

    stt_jobs: queue.Queue = queue.Queue()
    tts_jobs: queue.Queue = queue.Queue()
    cancelled: set = set()
    vad = SileroVad()
    vad.turn = load_turn_model()
    streams: dict[str, VadStream] = {}
    threading.Thread(target=stt_worker, args=(stt, vad, stt_jobs), daemon=True).start()
    threading.Thread(target=tts_worker, args=(tts, tts_jobs, cancelled), daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"op": "error", "message": "bad json"})
            continue
        op = req.get("op")
        if op == "stt":
            stt_jobs.put(req)
        elif op == "tts":
            tts_jobs.put(req)
        elif op == "tts_cancel":
            cancelled.add(req["id"])
        elif op == "vad_audio":
            # inline: cheap (well under 1 ms per frame) and keeps frames in order
            try:
                st = streams.get(req["stream"]) or streams.setdefault(req["stream"], vad.new_stream())
                for event, audio in st.feed(pcm16_to_float(req["pcm16"])):
                    ev = {"op": "vad", "stream": req["stream"], "event": event}
                    if audio is not None:
                        ev["pcm16"] = float_to_pcm16(audio)
                        ev["how"] = st.how
                    emit(ev)
            except Exception as e:
                emit({"op": "error", "message": f"vad: {e}"})
        elif op == "vad_reset":
            streams.pop(req.get("stream"), None)
        elif op == "ping":
            emit({"op": "pong"})
        else:
            emit({"op": "error", "id": req.get("id"), "message": f"unknown op {op}"})


if __name__ == "__main__":
    main()
