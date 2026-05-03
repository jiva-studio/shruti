package studio.jiva.shruti.mediadownloader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Notification helpers for the foreground download worker.
 *
 * Channel id is fixed (`shruti.media-downloader`) so it survives plugin
 * recreation. The channel is created at low importance — a download is a
 * background utility, not something to interrupt the user with sound.
 */
internal object DownloadNotification {
    const val CHANNEL_ID = "shruti.media-downloader"
    private const val CHANNEL_NAME = "Media downloads"
    private const val CHANNEL_DESCRIPTION = "Background downloads of lecture media."

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = CHANNEL_DESCRIPTION
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }

    fun build(
        context: Context,
        title: String,
        body: String,
        progressPct: Int,
        indeterminate: Boolean,
    ): Notification {
        ensureChannel(context)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(body)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (indeterminate) {
            builder.setProgress(0, 0, true)
        } else {
            builder.setProgress(100, progressPct.coerceIn(0, 100), false)
        }
        return builder.build()
    }
}
