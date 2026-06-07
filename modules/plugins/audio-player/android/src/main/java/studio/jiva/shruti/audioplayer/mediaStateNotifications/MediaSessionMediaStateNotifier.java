package studio.jiva.shruti.audioplayer.mediaStateNotifications;

import android.app.Notification;
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

    // Last rendered notification content. The playback state (position) is
    // refreshed on every send(), but the notification + metadata are only
    // rebuilt when their visible content actually changes — otherwise a
    // steady progress tick would rebuild the whole notification (with fresh
    // PendingIntents and MediaStyle) on every emit, which is wasteful.
    private String lastTitle = null;
    private String lastArtist = null;
    private long lastDuration = -1;
    private Boolean lastPlaying = null;

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
            // Reset so the next playback rebuilds metadata + notification.
            lastTitle = null;
            lastArtist = null;
            lastDuration = -1;
            lastPlaying = null;
            return;
        }

        boolean playing = state.getState().equals("playing");

        // Always refresh the playback state — it's cheap and it's what drives
        // the lock-screen/notification seekbar, which the system interpolates
        // from the reported position + speed between content rebuilds.
        mediaSession.setPlaybackState(buildPlaybackState(state, playing));

        boolean metadataChanged =
                !state.getTitle().equals(lastTitle)
                || !state.getArtist().equals(lastArtist)
                || state.getDuration() != lastDuration;
        if (metadataChanged) {
            mediaSession.setMetadata(
                    new MediaMetadataCompat.Builder()
                        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.getTitle())
                        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.getArtist())
                        .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.getDuration())
                        .build()
            );
        }

        // The notification only needs rebuilding when its visible content
        // changes: the title/artist text or the play/pause action icon.
        // Position is reflected through the MediaSession seekbar above, so a
        // steady progress tick no longer rebuilds the whole notification and
        // its PendingIntents.
        boolean playingChanged = lastPlaying == null || lastPlaying != playing;
        if (metadataChanged || playingChanged) {
            notificationManager.notify(1, buildNotification(state, playing));
        }

        lastTitle = state.getTitle();
        lastArtist = state.getArtist();
        lastDuration = state.getDuration();
        lastPlaying = playing;
    }

    private PlaybackStateCompat buildPlaybackState(MediaState state, boolean playing) {
        return new PlaybackStateCompat.Builder()
                .setState(
                    playing
                            ? PlaybackStateCompat.STATE_PLAYING
                            : PlaybackStateCompat.STATE_PAUSED,
                    state.getPosition(),
                    // Report the real speed while playing so the lock screen
                    // interpolates position correctly between our (now
                    // infrequent) updates; 0 when paused so it holds.
                    playing ? state.getSpeed() : 0f)
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
                .build();
    }

    private Notification buildNotification(MediaState state, boolean playing) {
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

        return new NotificationCompat.Builder(context, "MediaPlaybackChannel")
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
                        playing
                                ? android.R.drawable.ic_media_pause
                                : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play",
                        MediaButtonReceiver.buildMediaButtonPendingIntent(
                                context, PlaybackStateCompat.ACTION_PLAY_PAUSE)))
                .addAction(new NotificationCompat.Action(
                        android.R.drawable.ic_media_ff,
                        "+15s",
                        fastForwardPendingIntent))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2)).build();
    }

    public void cleanup() {
        notificationManager.cancel(1);
        mediaSession.setActive(false);
        mediaSession.release();
    }
}
