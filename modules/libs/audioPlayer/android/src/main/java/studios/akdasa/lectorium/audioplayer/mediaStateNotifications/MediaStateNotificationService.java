package studios.akdasa.lectorium.audioplayer.mediaStateNotifications;

import android.media.MediaPlayer;
import android.os.Handler;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * This class is responsible for notifying the media state to the registered notifiers.
 * It runs in a separate thread and updates the media state every second.
 */
public final class MediaStateNotificationService {
    private final List<IMediaStateNotifier> notifiers = new ArrayList<>();
    private final MediaPlayer mediaPlayer;
    private boolean isRunning = true;
    private final MediaState state = new MediaState("", "stopped", "", "", 0, 0);
    private final Handler handler = new Handler(); 
    private final Runnable runnable = new Runnable() {
        @Override
        public void run() {
            if (!isRunning) { return; }
            update();
            handler.postDelayed(this, 1000);
        }
    };

    public MediaStateNotificationService(
            MediaPlayer mediaPlayer
    ) {
        this.mediaPlayer = mediaPlayer;
    }

    public void run() {
        isRunning = true;
        this.runnable.run();
    }

    public MediaState getState() {
        return this.state;
    }

    public void update() {
        state.setPosition(mediaPlayer.getCurrentPosition());
        for (IMediaStateNotifier notifier : notifiers) {
            notifier.send(state);
        }
    }

    public void addNotifier(IMediaStateNotifier notifier) {
        notifiers.add(notifier);
    }

    public void stop() {
        isRunning = false;
    }
}
