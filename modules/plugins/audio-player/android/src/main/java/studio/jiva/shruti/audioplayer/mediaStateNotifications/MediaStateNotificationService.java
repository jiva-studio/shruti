package studio.jiva.shruti.audioplayer.mediaStateNotifications;

import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * This class is responsible for notifying the media state to the registered notifiers.
 * It runs in a separate thread and updates the media state every 500ms when playing.
 * For paused/stopped states, notifications are sent once on state change.
 */
public final class MediaStateNotificationService {
    private final List<IMediaStateNotifier> notifiers = new ArrayList<>();
    private final ExoPlayer exoPlayer;
    private final MediaState state = new MediaState("", "stopped", "", "", 0, 0);

    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();

    // Track previous state to detect changes
    private String previousState = "stopped";
    private String previousTrackId = "";
    private long previousDuration = 0;

    public MediaStateNotificationService(ExoPlayer exoPlayer) {
        this.exoPlayer = exoPlayer;
        this.exoPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) {
                    state.setPosition(exoPlayer.getDuration());
                    exoPlayer.seekTo(exoPlayer.getDuration());
                }
            }
        });
    }

    public void run() {
        executor.scheduleWithFixedDelay(() -> {
            try {
                new Handler(Looper.getMainLooper()).post(this::update);
            } catch (Exception ignored) {
                // Ignore exceptions during shutdown
            }
        }, 0, 500, TimeUnit.MILLISECONDS);
    }

    public MediaState getState() {
        return this.state;
    }

    public void update() {
        long currentPosition = exoPlayer.getCurrentPosition();
        long duration = exoPlayer.getDuration();

        state.setPosition(currentPosition);
        state.setState(exoPlayer.isPlaying() ? "playing" : "paused");
        if (duration > 0 && duration != state.getDuration()) {
            state.setDuration(duration);
        }

        // Detect state changes
        boolean stateChanged = !state.getState().equals(previousState);
        boolean trackChanged = !state.getTrackId().equals(previousTrackId);
        boolean durationChanged = state.getDuration() != previousDuration;

        // Only send notifications when:
        // 1. State changed (play/pause/stop)
        // 2. Track changed
        // 3. Duration changed
        // 4. Currently playing (for progress updates)
        if (stateChanged || trackChanged || durationChanged || state.getState().equals("playing")) {
            for (IMediaStateNotifier notifier : notifiers) {
                notifier.send(state);
            }

            // Update previous values
            previousState = state.getState();
            previousTrackId = state.getTrackId();
            previousDuration = state.getDuration();
        }
    }

    public void addNotifier(IMediaStateNotifier notifier) {
        notifiers.add(notifier);
    }

    public void stop() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(1, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}