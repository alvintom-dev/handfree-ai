package dev.handfree.handfree

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Process-wide link between the Flutter side, the audio engine and the service. */
object Bridge {
    private val main = Handler(Looper.getMainLooper())
    var events: EventChannel.EventSink? = null
    var mic: EventChannel.EventSink? = null
    var status: Map<String, Any?> = emptyMap()
    lateinit var engine: AudioEngine
    /** A picture shared to the app, being shrunk; Dart takes it once. */
    @Volatile var shared: Future<ByteArray?>? = null

    fun emit(event: Map<String, Any?>) = main.post { events?.success(event) }
}

/** Done: one short soft tone and a tap. Approval: a double beep and a longer
 *  buzz, harder to miss with the phone in a pocket. Works with the screen locked. */
fun chime(ctx: Context, kind: String) {
    val approval = kind == "approval"
    try {
        val tone = android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, if (approval) 90 else 60)
        tone.startTone(if (approval) android.media.ToneGenerator.TONE_PROP_BEEP2 else android.media.ToneGenerator.TONE_PROP_ACK, 300)
        Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 600)
    } catch (_: RuntimeException) {
        // no tone generator on this device: the vibration still says it
    }
    val vibrator = if (android.os.Build.VERSION.SDK_INT >= 31)
        ctx.getSystemService(android.os.VibratorManager::class.java).defaultVibrator
    else @Suppress("DEPRECATION") ctx.getSystemService(android.os.Vibrator::class.java)
    val effect = if (approval) android.os.VibrationEffect.createWaveform(longArrayOf(0, 120, 80, 120), -1)
        else android.os.VibrationEffect.createOneShot(60, android.os.VibrationEffect.DEFAULT_AMPLITUDE)
    vibrator?.vibrate(effect)
}

/** A shared picture as a JPEG, long side at most 1600 px (upright: ImageDecoder applies the photo's rotation). */
fun shrinkPicture(ctx: Context, uri: Uri): ByteArray? = try {
    val bmp: Bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { decoder, info, _ ->
        val scale = min(1f, MAX_SIDE.toFloat() / max(info.size.width, info.size.height))
        decoder.setTargetSize((info.size.width * scale).roundToInt().coerceAtLeast(1), (info.size.height * scale).roundToInt().coerceAtLeast(1))
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
    ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
} catch (_: Exception) {
    null
}

private const val MAX_SIDE = 1600
private val decodePool = Executors.newSingleThreadExecutor()

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        takeShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeShare(intent)
    }

    /** Share to Handfree: shrink the picture off the main thread, then tell Dart to fetch it. */
    private fun takeShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("image/") != true) return
        val uri = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        uri ?: return
        intent.action = null // handled: a rotation or relaunch shouldn't attach it again
        val ctx = applicationContext
        Bridge.shared = decodePool.submit(Callable { shrinkPicture(ctx, uri) })
        Bridge.emit(mapOf("type" to "shared"))
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ctx: Context = applicationContext
        if (!isEngineReady()) Bridge.engine = AudioEngine(ctx)
        val engine = Bridge.engine
        engine.onEvent = { Bridge.emit(it) }
        engine.onMicFrame = { frame -> Handler(Looper.getMainLooper()).post { Bridge.mic?.success(frame) } }

        val messenger = flutterEngine.dartExecutor.binaryMessenger
        EventChannel(messenger, "handfree/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(args: Any?, sink: EventChannel.EventSink) { Bridge.events = sink }
            override fun onCancel(args: Any?) { Bridge.events = null }
        })
        EventChannel(messenger, "handfree/mic").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(args: Any?, sink: EventChannel.EventSink) { Bridge.mic = sink }
            override fun onCancel(args: Any?) { Bridge.mic = null }
        })
        MethodChannel(messenger, "handfree/audio").setMethodCallHandler { call, result ->
            when (call.method) {
                "startService" -> { HandfreeService.update(ctx); result.success(null) }
                "stopService" -> { HandfreeService.stop(ctx); result.success(null) }
                "status" -> {
                    @Suppress("UNCHECKED_CAST")
                    Bridge.status = (call.arguments as? Map<String, Any?>) ?: emptyMap()
                    HandfreeService.update(ctx)
                    result.success(null)
                }
                "startMic" -> result.success(engine.startMic())
                "stopMic" -> { engine.stopMic(); result.success(null) }
                "deviceName" -> result.success(listOf(android.os.Build.MANUFACTURER, android.os.Build.MODEL).joinToString(" ") { it.replaceFirstChar(Char::titlecase) })
                "play" -> {
                    engine.play(call.argument<String>("sayId")!!, call.argument<Int>("seq")!!, call.argument<ByteArray>("pcm")!!)
                    result.success(null)
                }
                "stopPlayback" -> { engine.stopPlayback(); result.success(null) }
                "pause" -> { engine.pausePlayback(); result.success(null) }
                "resume" -> { engine.resumePlayback(); result.success(null) }
                "duck" -> { engine.duck(); result.success(null) }
                "unduck" -> { engine.unduck(); result.success(null) }
                "setMuted" -> { engine.muted = call.argument<Boolean>("muted") == true; result.success(null) }
                "chime" -> { chime(ctx, call.argument<String>("kind") ?: "done"); result.success(null) }
                "takeShared" -> {
                    val job = Bridge.shared
                    Bridge.shared = null
                    if (job == null) result.success(null)
                    else thread { val bytes = try { job.get() } catch (_: Exception) { null }; Handler(Looper.getMainLooper()).post { result.success(bytes) } }
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun onDestroy() {
        // swiped away: the Dart side (and its connection) is gone, so stop the service too
        if (isFinishing) {
            Bridge.engine.release()
            HandfreeService.stop(applicationContext)
        }
        super.onDestroy()
    }

    private fun isEngineReady(): Boolean = try { Bridge.engine; true } catch (_: UninitializedPropertyAccessException) { false }
}
