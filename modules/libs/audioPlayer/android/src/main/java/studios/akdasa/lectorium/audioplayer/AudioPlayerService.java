package studios.akdasa.lectorium.audioplayer;

import static android.media.MediaPlayer.SEEK_PREVIOUS_SYNC;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.PluginCall;

import studios.akdasa.lectorium.audioplayer.mediaSession.MediaSessionCallback;
import studios.akdasa.lectorium.audioplayer.mediaStateNotifications.MediaSessionMediaStateNotifier;
import studios.akdasa.lectorium.audioplayer.mediaStateNotifications.MediaStateNotificationService;
import studios.akdasa.lectorium.audioplayer.mediaStateNotifications.PluginCallMediaStateNotifier;


public final class AudioPlayerService extends Service {
    private static final String CHANNEL_ID = "MediaPlaybackChannel";
    private static final int NOTIFICATION_ID = 1;

    private MediaPlayer mediaPlayer;
    private MediaStateNotificationService mediaStateNotificationService;
    private NotificationManager notificationManager;

    @Override
    public void onCreate() {
        super.onCreate();
        Context context = getApplicationContext();
        mediaPlayer = new MediaPlayer();
        mediaStateNotificationService = new MediaStateNotificationService(mediaPlayer);

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
        if (mediaPlayer != null) { mediaPlayer.release(); }
        this.stopForeground(true);
        this.stopSelf();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notificationManager.deleteNotificationChannel(CHANNEL_ID);
        }
        super.onDestroy();
    }

    MediaPlayer getMediaPlayer() {
        return mediaPlayer;
    }

    public void open(
            String trackId,
            String url,
            String trackTitle,
            String trackArtist
    ) {
        try {
            mediaPlayer.reset();
            mediaPlayer.setDataSource(url);
            mediaPlayer.prepare();
            mediaStateNotificationService.getState().setTrackId(trackId); 
            mediaStateNotificationService.getState().setTitle(trackTitle);
            mediaStateNotificationService.getState().setArtist(trackArtist);
            mediaStateNotificationService.getState().setPosition(0);
            mediaStateNotificationService.getState().setDuration(mediaPlayer.getDuration());
            mediaStateNotificationService.getState().setState("stopped");
            mediaStateNotificationService.update();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void play() {
        if (!mediaPlayer.isPlaying()) {
            mediaPlayer.start();
            mediaStateNotificationService.getState().setState("playing");
            mediaStateNotificationService.update();
        }
    }

    public void togglePause() {
        if (mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
            mediaStateNotificationService.getState().setState("paused");
        } else {
            mediaPlayer.start();
            mediaStateNotificationService.getState().setState("playing");
        }
        mediaStateNotificationService.update();
    }

    public void seek(long position) {
        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                mediaPlayer.seekTo(position, SEEK_PREVIOUS_SYNC);
            } else {
                mediaPlayer.seekTo((int)position);
            }
            mediaStateNotificationService.getState().setState("playing");
            mediaStateNotificationService.getState().setPosition(position);
            mediaStateNotificationService.update();
        }
    }

    public void stop() {
        mediaPlayer.stop();
        mediaPlayer.reset();
        mediaStateNotificationService.getState().setState("stopped");
        mediaStateNotificationService.getState().setPosition(0);
        mediaStateNotificationService.update();
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