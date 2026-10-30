// Mic capture for streaming to the daemon: 16 kHz mono (the AudioContext runs
// at 16 kHz, so the browser resamples), sent as 32 ms PCM16 frames.
class MicStream extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(512)
    this.n = 0
  }

  process(inputs) {
    const ch = inputs[0]?.[0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.frame[this.n++] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767)))
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer])
          this.frame = new Int16Array(512)
          this.n = 0
        }
      }
    }
    return true
  }
}

registerProcessor('mic-stream', MicStream)
