package studio.jiva.shruti.audioplayer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import com.getcapacitor.PluginCall;

import studio.jiva.shruti.audioplayer.audioprocessor.StereoMixAudioProcessor;
import studio.jiva.shruti.audioplayer.mediaSession.MediaSessionActions;
import studio.jiva.shruti.audioplayer.mediaSession.MediaSessionCallback;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.MediaSessionMediaStateNotifier;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.MediaState;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.MediaStateNotificationService;
import studio.jiva.shruti.audioplayer.mediaStateNotifications.PluginCallMediaStateNotifier;


public final class AudioPlayerService extends Service {
    private static final String CHANNEL_ID = "MediaPlaybackChannel";
    private static final int NOTIFICATION_ID = 1;
    /** Fallback text used in the foreground-service notification before any
     *  track metadata is known (i.e. between onStartCommand and the first
     *  MediaSession update). Kept user-visible and descriptive so the FGS
     *  notification still tells the user what the service is doing, which
     *  Google Play's FGS review requires. */
    private static final String FALLBACK_NOTIFICATION_TITLE = "Lectorium audio";

    private ExoPlayer exoPlayer;
    private MediaStateNotificationService mediaStateNotificationService;
    private MediaSessionMediaStateNotifier mediaSessionNotifier;
    private NotificationManager notificationManager;
    private BroadcastReceiver skipActionReceiver;
    private final StereoMixAudioProcessor stereoMixProcessor = new StereoMixAudioProcessor();

    @Override
    public void onCreate() {
        super.onCreate();
        Context context = getApplicationContext();

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(context) {
            @Override
            protected AudioSink buildAudioSink(
                    Context context,
                    boolean enableFloatOutput,
                    boolean enableAudioTrackPlaybackParams) {
                // Same defaults as DefaultRenderersFactory.buildAudioSink, plus
                // our stereo→mono blender. Audio offload is implicitly off
                // because supplying a non-default processor chain forces the
                // sink to a software path; that's what we want — offload
                // would route around our processor entirely.
                return new DefaultAudioSink.Builder(context)
                        .setEnableFloatOutput(enableFloatOutput)
                        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                        .setAudioProcessors(new AudioProcessor[]{stereoMixProcessor})
                        .build();
            }
        };

        exoPlayer = new ExoPlayer.Builder(context, renderersFactory)
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

        // Register BroadcastReceiver for skip actions
        skipActionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (MediaSessionActions.ACTION_REWIND.equals(action)) {
                    seekBy(-15000);
                } else if (MediaSessionActions.ACTION_FAST_FORWARD.equals(action)) {
                    seekBy(15000);
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(MediaSessionActions.ACTION_REWIND);
        filter.addAction(MediaSessionActions.ACTION_FAST_FORWARD);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(skipActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(skipActionReceiver, filter);
        }

        // Set media state change notification service
        mediaSessionNotifier = new MediaSessionMediaStateNotifier(
                context,
                notificationManager,
                new MediaSessionCallback(this));
        mediaStateNotificationService.addNotifier(mediaSessionNotifier);
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
        if (mediaSessionNotifier != null) {
            mediaSessionNotifier.cleanup();
        }
        if (skipActionReceiver != null) {
            unregisterReceiver(skipActionReceiver);
        }
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
                exoPlayer.stop();
                exoPlayer.clearMediaItems();
                exoPlayer.setMediaItem(mediaItem);
                exoPlayer.prepare();

                mediaStateNotificationService.getState().setTrackId(trackId);
                mediaStateNotificationService.getState().setTitle(trackTitle);
                mediaStateNotificationService.getState().setArtist(trackArtist);
                mediaStateNotificationService.getState().setPosition(0);
                mediaStateNotificationService.getState().setDuration(0);
                mediaStateNotificationService.getState().setState("stopped");
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

    public void pause() {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (exoPlayer.isPlaying()) {
                exoPlayer.setPlayWhenReady(false);
                mediaStateNotificationService.getState().setState("paused");
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

    public void seekBy(long delta) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (exoPlayer != null) {
                long currentPosition = exoPlayer.getCurrentPosition();
                long duration = exoPlayer.getDuration();
                long newPosition = Math.max(0, Math.min(currentPosition + delta, duration));
                exoPlayer.seekTo(newPosition);
                mediaStateNotificationService.getState().setState(exoPlayer.isPlaying() ? "playing" : "paused");
                mediaStateNotificationService.getState().setPosition(newPosition);
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

    /** Adjust how often progress is pushed to the WebView while playing.
     *  Delegated to the notification service, which reschedules its loop. */
    public void setProgressInterval(long intervalMs) {
        mediaStateNotificationService.setEmitInterval(intervalMs);
    }

    /** Forward the slider state to the AudioProcessor sitting in the
     *  ExoPlayer audio pipeline. Volatile fields make this safe to call
     *  from the Capacitor bridge thread while the audio render thread
     *  reads them. */
    public void setMix(boolean enabled, float ratio) {
        stereoMixProcessor.setMix(enabled, ratio);
    }

    /** Set playback rate; pitch is preserved (default `pitch=1f` in
     *  PlaybackParameters), so a 2× lecture still sounds like a human.
     *  Posted on the main looper to match the rest of the ExoPlayer
     *  control surface. */
    public void setPlaybackRate(float rate) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (exoPlayer != null) {
                exoPlayer.setPlaybackParameters(new PlaybackParameters(rate));
            }
        });
    }

    /** Build the foreground-service notification.
     *
     *  Once a track is loaded, MediaSessionMediaStateNotifier replaces this
     *  with a full MediaStyle notification (same NOTIFICATION_ID). But for
     *  the brief window between onStartCommand and the first state update,
     *  this notification is what the user sees — so it must describe the
     *  actual playback state instead of the previous hardcoded
     *  "Media Playback / Playing media" placeholder, which Google Play's
     *  FGS review treats as a non-descriptive notification.
     */
    private Notification createNotification() {
        Intent notificationIntent = new Intent(this, getApplicationContext().getClass());
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE);

        String title = FALLBACK_NOTIFICATION_TITLE;
        String text = null;
        if (mediaStateNotificationService != null) {
            MediaState state = mediaStateNotificationService.getState();
            if (state != null) {
                String stateTitle = state.getTitle();
                if (stateTitle != null && !stateTitle.isEmpty()) {
                    title = stateTitle;
                }
                String stateArtist = state.getArtist();
                if (stateArtist != null && !stateArtist.isEmpty()) {
                    text = stateArtist;
                }
            }
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pendingIntent)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true);
        if (text != null) {
            builder.setContentText(text);
        }
        return builder.build();
    }
}