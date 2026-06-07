package studio.jiva.shruti.audioplayer.mediaStateNotifications;

import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * This class is responsible for notifying the media state to the registered notifiers.
 * It runs in a separate thread and pushes the media state at a configurable
 * interval while playing. For paused/stopped states, notifications are sent
 * once on state change and then the stream goes quiet.
 *
 * The interval is adaptive (see {@link #setEmitInterval(long)}): the JS layer
 * speeds it up when a transcript view needs sub-second word highlighting and
 * slows it to a heartbeat when the app is backgrounded, so a 2 Hz stream
 * never piles up in the (throttled) WebView and flushes as a janky burst on
 * resume. The system player / lock screen interpolates position between
 * updates from the reported playback speed, so it stays smooth regardless.
 */
public final class MediaStateNotificationService {
    /** Foreground default; matches the floating-player progress ring needs. */
    private static final long DEFAULT_INTERVAL_MS = 1000;
    /** Floor — guards against a pathological caller pinning the CPU. */
    private static final long MIN_INTERVAL_MS = 250;

    private final List<IMediaStateNotifier> notifiers = new ArrayList<>();
    private final ExoPlayer exoPlayer;
    private final MediaState state = new MediaState("", "stopped", "", "", 0, 0);

    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> scheduledTask;
    private long intervalMs = DEFAULT_INTERVAL_MS;

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
        schedule();
    }

    /** (Re)schedule the polling loop at the current {@link #intervalMs}. */
    private synchronized void schedule() {
        if (scheduledTask != null) {
            scheduledTask.cancel(false);
        }
        scheduledTask = executor.scheduleWithFixedDelay(() -> {
            try {
                new Handler(Looper.getMainLooper()).post(this::update);
            } catch (Exception ignored) {
                // Ignore exceptions during shutdown
            }
        }, 0, intervalMs, TimeUnit.MILLISECONDS);
    }

    /**
     * Change how often progress is pushed while playing. No-op if the
     * interval is unchanged; otherwise the loop is rescheduled. Safe to
     * call from the Capacitor bridge thread.
     */
    public synchronized void setEmitInterval(long ms) {
        long clamped = Math.max(MIN_INTERVAL_MS, ms);
        if (clamped == intervalMs) {
            return;
        }
        intervalMs = clamped;
        schedule();
    }

    public MediaState getState() {
        return this.state;
    }

    public void update() {
        long currentPosition = exoPlayer.getCurrentPosition();
        long duration = exoPlayer.getDuration();

        state.setPosition(currentPosition);
        state.setState(exoPlayer.isPlaying() ? "playing" : "paused");
        state.setSpeed(exoPlayer.getPlaybackParameters().speed);
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