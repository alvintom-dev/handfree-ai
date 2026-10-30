package dev.handfree.handfree

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread
import kotlin.math.max

/**
 * Mic capture and speech playback, both on the voice-communication path so the
 * platform echo canceller can subtract Claude's voice from the mic.
 * Mic: 16 kHz mono PCM16 in 100 ms frames. Playback: queued sentences, 24 kHz.
 */
class AudioEngine(context: Context) {
    private val am = context.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())

    var onMicFrame: ((ByteArray) -> Unit)? = null
    var onEvent: ((Map<String, Any?>) -> Unit)? = null

    // --- mic ------------------------------------------------------------------------

    private var record: AudioRecord? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    @Volatile private var micOn = false
    private var micThread: Thread? = null

    @Synchronized
    fun startMic(): Boolean {
        if (micOn) return true
        enterCommunicationMode()
        val min = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, FRAME_BYTES * 4))
        } catch (e: SecurityException) {
            return false
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); return false }
        if (AcousticEchoCanceler.isAvailable()) aec = AcousticEchoCanceler.create(r.audioSessionId)?.apply { enabled = true }
        if (NoiseSuppressor.isAvailable()) ns = NoiseSuppressor.create(r.audioSessionId)?.apply { enabled = true }
        r.startRecording()
        record = r
        micOn = true
        micThread = thread(name = "handfree-mic", priority = Thread.MAX_PRIORITY) {
            val buf = ByteArray(FRAME_BYTES)
            while (micOn) {
                var off = 0
                while (off < buf.size && micOn) {
                    val n = r.read(buf, off, buf.size - off)
                    if (n <= 0) break
                    off += n
                }
                if (off == buf.size) onMicFrame?.invoke(buf.copyOf())
            }
        }
        emit("mic", mapOf("on" to true, "aec" to (aec != null)))
        return true
    }

    @Synchronized
    fun stopMic() {
        if (!micOn) return
        micOn = false
        micThread?.join(500)
        record?.run { try { stop() } catch (_: Exception) {}; release() }
        aec?.release(); ns?.release()
        record = null; aec = null; ns = null
        emit("mic", mapOf("on" to false))
    }

    // --- playback ---------------------------------------------------------------------

    private data class Chunk(val gen: Int, val sayId: String, val seq: Int, val pcm: ByteArray)
    private data class Mark(val frame: Long, val sayId: String, val seq: Int)

    private val queue = LinkedBlockingQueue<Chunk>()
    @Volatile private var gen = 0
    @Volatile private var written = 0L // frames handed to the track, in head-position units
    private val marks = ArrayDeque<Mark>()
    private var playing = false
    private var track: AudioTrack? = null
    private var level = 1f // 1, or 0.15 while ducked

    /** Muted: speech still plays (positions, playing, barge-in all as usual), at volume 0. */
    @Volatile var muted = false
        set(on) { field = on; applyVolume() }

    private fun volume(v: Float) { level = v; applyVolume() }
    private fun applyVolume() { track?.setVolume(if (muted) 0f else level) }

    private fun track(): AudioTrack {
        track?.let { return it }
        val min = AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .setAudioFormat(AudioFormat.Builder()
                .setSampleRate(OUT_RATE)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(max(min, OUT_RATE)) // ~0.5 s
            .build()
        track = t
        applyVolume()
        t.play()
        thread(name = "handfree-play", isDaemon = true) { writer(t) }
        main.post(::monitor)
        return t
    }

    fun play(sayId: String, seq: Int, pcm: ByteArray) {
        enterCommunicationMode()
        track()
        queue.put(Chunk(gen, sayId, seq, pcm))
    }

    private fun writer(t: AudioTrack) {
        while (true) {
            val c = queue.take()
            if (c.gen != gen) continue
            synchronized(marks) { marks.addLast(Mark(written, c.sayId, c.seq)) }
            var off = 0
            while (off < c.pcm.size && c.gen == gen) {
                val n = t.write(c.pcm, off, minOf(PLAY_PIECE, c.pcm.size - off))
                if (n <= 0) break
                off += n
                written += n / 2
            }
        }
    }

    /** Reports which sentence is audible and whether anything is playing. */
    private fun monitor() {
        val t = track ?: return
        val head = t.playbackHeadPosition.toLong() and 0xffffffffL
        var reached: Mark? = null
        synchronized(marks) {
            while (marks.isNotEmpty() && marks.first().frame <= head) reached = marks.removeFirst()
        }
        reached?.let { emit("pos", mapOf("sayId" to it.sayId, "seq" to it.seq)) }
        val nowPlaying = head < written && t.playState == AudioTrack.PLAYSTATE_PLAYING
        if (nowPlaying != playing) {
            playing = nowPlaying
            emit("playing", mapOf("on" to nowPlaying))
            if (!nowPlaying) maybeLeaveCommunicationMode()
        }
        main.postDelayed(::monitor, 40)
    }

    fun stopPlayback() {
        gen++
        queue.clear()
        track?.let { t ->
            t.pause(); t.flush(); volume(1f)
            written = t.playbackHeadPosition.toLong() and 0xffffffffL
            synchronized(marks) { marks.clear() }
            t.play()
        }
    }

    fun pausePlayback() { track?.pause() }
    fun resumePlayback() { volume(1f); track?.play() }
    fun duck() = volume(0.15f)
    fun unduck() = volume(1f)

    // --- routing ----------------------------------------------------------------------

    private var inComm = false

    /** Communication mode turns on echo cancellation; route to a headset if present, else the loudspeaker. */
    private fun enterCommunicationMode() {
        if (inComm) return
        inComm = true
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = am.availableCommunicationDevices
            val headset = devices.firstOrNull { it.type in HEADSET_TYPES }
            (headset ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER })?.let { am.setCommunicationDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = !am.isWiredHeadsetOn && !am.isBluetoothScoOn
        }
    }

    private fun maybeLeaveCommunicationMode() {
        if (!inComm || micOn || playing) return
        inComm = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        am.mode = AudioManager.MODE_NORMAL
    }

    fun release() {
        stopMic()
        stopPlayback()
        track?.release()
        track = null
        maybeLeaveCommunicationMode()
    }

    private fun emit(type: String, data: Map<String, Any?>) {
        main.post { onEvent?.invoke(data + ("type" to type)) }
    }

    companion object {
        const val MIC_RATE = 16000
        const val OUT_RATE = 24000
        const val FRAME_BYTES = MIC_RATE * 2 / 10 // 100 ms
        const val PLAY_PIECE = OUT_RATE / 10 * 2 // write 100 ms at a time so stop is quick
        val HEADSET_TYPES = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET, 26 /* TYPE_BLE_HEADSET */,
        )
    }
}
