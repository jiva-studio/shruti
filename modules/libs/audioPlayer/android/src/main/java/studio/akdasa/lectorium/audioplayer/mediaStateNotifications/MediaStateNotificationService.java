package studio.jiva.shruti.audioplayer.mediaStateNotifications;

import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * This class is responsible for notifying the media state to the registered notifiers.
 * It runs in a separate thread and updates the media state every 100ms.
 */
public final class MediaStateNotificationService {
    private final List<IMediaStateNotifier> notifiers = new ArrayList<>();
    private final ExoPlayer exoPlayer;
    private final MediaState state = new MediaState("", "stopped", "", "", 0, 0);

    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private boolean isUpdating = false;
    private boolean isRunning = false;

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
        //if (isRunning) return;
        //isRunning = true;
        executor.scheduleWithFixedDelay(() -> {
//            if (isUpdating) {
            try {
                new Handler(Looper.getMainLooper()).post(this::update);
            } catch (Exception e) {
                isRunning = false;
            }
//            }
        }, 0, 500, TimeUnit.MILLISECONDS);
    }

    public void setUpdating(boolean updating) {
        isUpdating = updating;
    }

    public MediaState getState() {
        return this.state;
    }

    public void update() {
        long currentPosition = exoPlayer.getCurrentPosition();
        long duration = exoPlayer.getDuration();

//        if (exoPlayer.isPlaying()) {
//            // Add elapsed time since last position update
//            val elapsedSinceUpdate = SystemClock.elapsedRealtime() - lastPositionUpdateTime
//            return currentPos + (elapsedSinceUpdate * playbackSpeed).toLong()
//        }

        state.setPosition(currentPosition);
        state.setState(exoPlayer.isPlaying() ? "playing" : "paused");

        if (duration > 0 && duration != state.getDuration()) {
            state.setDuration(duration);
        }

        for (IMediaStateNotifier notifier : notifiers) {
            notifier.send(state);
        }
    }

    public void addNotifier(IMediaStateNotifier notifier) {
        notifiers.add(notifier);
    }

    public void stop() {
        isRunning = false;
        executor.shutdownNow();
    }
}