package dev.handfree.handfree

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the app alive with the screen locked: a foreground service (microphone
 * + media playback) with a status notification and quick actions, plus Wi-Fi
 * and CPU locks so the voice link doesn't drop.
 */
class HandfreeService : Service() {
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        // default importance so it shows on the lock screen and outside "Silent"; no sound or buzz
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Handfree voice", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Shows what Claude is doing and quick controls"
            setSound(null, null)
            enableVibration(false)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
        wifiLock = getSystemService(WifiManager::class.java).createWifiLock(
            if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "handfree:wifi",
        ).apply { acquire() }
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "handfree:cpu").apply { acquire() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE, null -> {
                val types = if (Build.VERSION.SDK_INT >= 30)
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                else 0
                ServiceCompat.startForeground(this, NOTIFICATION_ID, build(Bridge.status), types)
            }
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            else -> Bridge.emit(mapOf("type" to "action", "action" to intent.action!!.removePrefix(PREFIX), "requestId" to intent.getStringExtra("requestId")))
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wifiLock?.release()
        wakeLock?.release()
        super.onDestroy()
    }

    private fun build(s: Map<String, Any?>): Notification {
        val title = s["title"] as? String ?: "Handfree"
        val text = s["text"] as? String ?: "Ready"
        val listening = s["listening"] as? Boolean ?: false
        val approvalId = s["approvalId"] as? String
        val open = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_handfree)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        if (approvalId != null) {
            b.addAction(0, "Approve", action("approve", approvalId))
            b.addAction(0, "Deny", action("deny", approvalId))
        } else {
            b.addAction(0, if (listening) "Pause listening" else "Listen", action(if (listening) "pause_listening" else "resume_listening", null))
            b.addAction(0, "Stop speaking", action("stop_speaking", null))
            b.addAction(0, "Replay", action("replay", null))
        }
        return b.build()
    }

    private fun action(name: String, requestId: String?): PendingIntent {
        val i = Intent(this, HandfreeService::class.java).setAction(PREFIX + name).putExtra("requestId", requestId)
        return PendingIntent.getService(this, name.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        const val CHANNEL = "handfree.status"
        const val NOTIFICATION_ID = 7
        const val PREFIX = "dev.handfree.action."
        const val ACTION_UPDATE = "dev.handfree.UPDATE"
        const val ACTION_STOP = "dev.handfree.STOP"

        fun update(context: Context) {
            val i = Intent(context, HandfreeService::class.java).setAction(ACTION_UPDATE)
            context.startForegroundService(i)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, HandfreeService::class.java).setAction(ACTION_STOP))
        }
    }
}
