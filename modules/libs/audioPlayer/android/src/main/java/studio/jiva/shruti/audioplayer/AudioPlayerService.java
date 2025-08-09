package studio.jiva.shruti.audioplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.PluginCall;

import studio.jiva.shruti.audioplayer.mediaSession.MediaSessionCallback;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.MediaSessionMediaStateNotifier;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.MediaStateNotificationService;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.PluginCallMediaStateNotifier;


public final class AudioPlayerService extends Service {
    private static final String CHANNEL_ID = "MediaPlaybackChannel";
    private static final int NOTIFICATION_ID = 1;

    private ExoPlayer exoPlayer;
    private MediaStateNotificationService mediaStateNotificationService;
    private NotificationManager notificationManager;

    @Override
    public void onCreate() {
        super.onCreate();
        Context context = getApplicationContext();

        exoPlayer = new ExoPlayer.Builder(context)
                .build();
        mediaStateNotificationService = new MediaStateNotificationService(exoPlayer);

        // Create notification channel
        notificationManager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationManager.createNotificationChannel(
                    new NotificationChannel(
                            CHANNEL_ID, "Media Playback", NotificationManager.IMPORTANCE_LOW)
            );
        }

        // Set media state change notification service
        mediaStateNotificationService.addNotifier(new MediaSessionMediaStateNotifier(
                context,
                notificationManager,
                new MediaSessionCallback(this)));
        mediaStateNotificationService.run();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, createNotification());
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return new AudioPlayerServiceBinder(this);
    }

    @Override
    public void onDestroy() {
        mediaStateNotificationService.stop();
        if (exoPlayer != null) { exoPlayer.release(); }
        this.stopForeground(true);
        this.stopSelf();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationManager.deleteNotificationChannel(CHANNEL_ID);
        }
        super.onDestroy();
    }

    ExoPlayer getExoPlayer() {
        return exoPlayer;
    }

    public void open(
            String trackId,
            String url,
            String trackTitle,
            String trackArtist
    ) {
        try {
            MediaItem mediaItem = MediaItem.fromUri(url);

            new Handler(Looper.getMainLooper()).post(() -> {
                mediaStateNotificationService.setUpdating(false);
                exoPlayer.stop();
                exoPlayer.clearMediaItems();
                exoPlayer.setMediaItem(mediaItem);
                exoPlayer.prepare();
                mediaStateNotificationService.getState().setTrackId(trackId);
                mediaStateNotificationService.getState().setTitle(trackTitle);
                mediaStateNotificationService.getState().setArtist(trackArtist);
                mediaStateNotificationService.getState().setPosition(0);
                // Duration will be updated later when available
                mediaStateNotificationService.getState().setDuration(0);
                mediaStateNotificationService.getState().setState("stopped");
                mediaStateNotificationService.setUpdating(true);
                mediaStateNotificationService.update();
            });
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void play() {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (!exoPlayer.isPlaying()) {
                exoPlayer.setPlayWhenReady(true);
                mediaStateNotificationService.getState().setState("playing");
                mediaStateNotificationService.update();
            }
        });
    }

    public void togglePause() {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (exoPlayer.isPlaying()) {
                exoPlayer.setPlayWhenReady(false);
                mediaStateNotificationService.getState().setState("paused");
            } else {
                exoPlayer.setPlayWhenReady(true);
                mediaStateNotificationService.getState().setState("playing");
            }
            mediaStateNotificationService.update();
        });
    }

    public void seek(long position) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (exoPlayer != null) {
                exoPlayer.seekTo(position);
                mediaStateNotificationService.getState().setState(exoPlayer.isPlaying() ? "playing" : "paused");
                mediaStateNotificationService.getState().setPosition(position);
                mediaStateNotificationService.update();
            }
        });
    }

    public void stop() {
        new Handler(Looper.getMainLooper()).post(() -> {
            exoPlayer.stop();
            exoPlayer.clearMediaItems();
            mediaStateNotificationService.getState().setState("stopped");
            mediaStateNotificationService.getState().setPosition(0);
            mediaStateNotificationService.getState().setTrackId("");
            mediaStateNotificationService.getState().setTitle("");
            mediaStateNotificationService.getState().setArtist("");
            mediaStateNotificationService.getState().setPosition(0);
            mediaStateNotificationService.getState().setDuration(0);
            mediaStateNotificationService.update();
        });
    }

    public void setOnProgressChangeCall(PluginCall call) {
        mediaStateNotificationService.addNotifier(new PluginCallMediaStateNotifier(call));
    }

    private Notification createNotification() {
        Intent notificationIntent = new Intent(this, getApplicationContext().getClass());
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Media Playback")
                .setContentText("Playing media")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pendingIntent)
                .build();
    }
}