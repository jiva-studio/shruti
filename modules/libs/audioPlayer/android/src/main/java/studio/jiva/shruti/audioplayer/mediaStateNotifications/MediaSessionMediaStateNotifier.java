package studio.jiva.shruti.audioplayer.mediaStateNotifications;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;

import studio.jiva.shruti.audioplayer.mediaSession.MediaSessionActions;

public final class MediaSessionMediaStateNotifier implements IMediaStateNotifier {
    private final MediaSessionCompat mediaSession;
    private final Context context;
    private final NotificationManager notificationManager;

    public MediaSessionMediaStateNotifier(
            Context context,
            NotificationManager notificationManager,
            MediaSessionCompat.Callback mediaSessionCallback
    ) {
        this.context = context;
        this.notificationManager = notificationManager;
        this.mediaSession = new MediaSessionCompat(context, "MediaSessionPlugin");
        mediaSession.setMediaButtonReceiver(PendingIntent.getBroadcast(
                context,
                0,
                new Intent(Intent.ACTION_MEDIA_BUTTON),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        ));
        this.mediaSession.setCallback(mediaSessionCallback);
        this.mediaSession.setActive(true);
    }

    @Override
    public void send(MediaState state) {
        // If stopped (empty title), cancel notification and set stopped state
        if (state.getTitle().isEmpty() || state.getState().equals("stopped")) {
            notificationManager.cancel(1);
            mediaSession.setPlaybackState(
                    new PlaybackStateCompat.Builder()
                        .setState(PlaybackStateCompat.STATE_STOPPED, 0, 1.0f)
                        .build()
            );
            return;
        }

        mediaSession.setMetadata(
                new MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.getTitle())
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.getArtist())
                    .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.getDuration())
                    .build()
        );

        mediaSession.setPlaybackState(
                new PlaybackStateCompat.Builder()
                    .setState(
                        state.getState().equals("playing")
                                ? PlaybackStateCompat.STATE_PLAYING
                                : PlaybackStateCompat.STATE_PAUSED,
                        state.getPosition(), 1.0f)
                    .setActions(
                        PlaybackStateCompat.ACTION_PLAY |
                        PlaybackStateCompat.ACTION_PAUSE |
                        PlaybackStateCompat.ACTION_FAST_FORWARD |
                        PlaybackStateCompat.ACTION_REWIND |
                        PlaybackStateCompat.ACTION_SEEK_TO)
                    .addCustomAction(
                        new PlaybackStateCompat.CustomAction.Builder(
                            MediaSessionActions.ACTION_REWIND,
                            "-15s",
                            android.R.drawable.ic_media_rew)
                            .build())
                    .addCustomAction(
                        new PlaybackStateCompat.CustomAction.Builder(
                            MediaSessionActions.ACTION_FAST_FORWARD,
                            "+15s",
                            android.R.drawable.ic_media_ff)
                            .build())
                    .build()
        );

        // Create PendingIntents for custom skip actions
        Intent rewindIntent = new Intent(MediaSessionActions.ACTION_REWIND);
        rewindIntent.setPackage(context.getPackageName());
        PendingIntent rewindPendingIntent = PendingIntent.getBroadcast(
                context, 1, rewindIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent fastForwardIntent = new Intent(MediaSessionActions.ACTION_FAST_FORWARD);
        fastForwardIntent.setPackage(context.getPackageName());
        PendingIntent fastForwardPendingIntent = PendingIntent.getBroadcast(
                context, 2, fastForwardIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        notificationManager.notify(
                1,
                new NotificationCompat.Builder(context, "MediaPlaybackChannel")
                    .setContentTitle(state.getTitle())
                    .setContentText(state.getArtist())
                    .setSmallIcon(context.getApplicationInfo().icon)
                    .setContentIntent(mediaSession.getController().getSessionActivity())
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .addAction(new NotificationCompat.Action(
                            android.R.drawable.ic_media_rew,
                            "-15s",
                            rewindPendingIntent))
                    .addAction(new NotificationCompat.Action(
                            state.getState().equals("playing")
                                    ? android.R.drawable.ic_media_pause
                                    : android.R.drawable.ic_media_play,
                            state.getState().equals("playing")
                                    ? "Pause"
                                    : "Play",
                            MediaButtonReceiver.buildMediaButtonPendingIntent(
                                    context, PlaybackStateCompat.ACTION_PLAY_PAUSE)))
                    .addAction(new NotificationCompat.Action(
                            android.R.drawable.ic_media_ff,
                            "+15s",
                            fastForwardPendingIntent))
                    .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                            .setMediaSession(mediaSession.getSessionToken())
                            .setShowActionsInCompactView(0, 1, 2)).build());
    }

    public void cleanup() {
        notificationManager.cancel(1);
        mediaSession.setActive(false);
        mediaSession.release();
    }
}
