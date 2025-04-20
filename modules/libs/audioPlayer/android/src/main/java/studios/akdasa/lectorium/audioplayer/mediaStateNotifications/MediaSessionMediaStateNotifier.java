package studios.akdasa.lectorium.audioplayer.mediaStateNotifications;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;

// .setDeleteIntent(MediaButtonReceiver.buildMediaButtonPendingIntent(service.context, PlaybackStateCompat.ACTION_STOP))

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
        if (state.getTitle().isEmpty()) {
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
                        PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE)
                    .build()
        );

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
                            state.getState().equals("playing")
                                    ? android.R.drawable.ic_media_pause
                                    : android.R.drawable.ic_media_play,
                            state.getState().equals("playing")
                                    ? "Pause"
                                    : "Play",
                            MediaButtonReceiver.buildMediaButtonPendingIntent(
                                    context, PlaybackStateCompat.ACTION_PLAY_PAUSE)))
                    .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                            .setMediaSession(mediaSession.getSessionToken())
                            .setShowActionsInCompactView(0)).build());
    }
}
