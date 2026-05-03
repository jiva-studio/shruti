package studio.jiva.shruti.audioplayer.mediaSession;

import android.content.Intent;
import android.support.v4.media.session.MediaSessionCompat;

import studio.jiva.shruti.audioplayer.AudioPlayerService;

public final class MediaSessionCallback extends MediaSessionCompat.Callback {
    private final AudioPlayerService service;

    public MediaSessionCallback(AudioPlayerService service) {
        this.service = service;
    }
    
    @Override
    public void onPlay() {
        service.play();
    }

    @Override
    public void onPause() {
        service.togglePause();
    }

    @Override
    public void onStop() {
        service.stop();
    }

    @Override
    public void onFastForward() {
        service.seekBy(15000);
    }

    @Override
    public void onRewind() {
        service.seekBy(-15000);
    }

    @Override
    public void onSeekTo(long position) {
        service.seek(position);
    }

    @Override
    public void onCustomAction(String action, android.os.Bundle extras) {
        if (MediaSessionActions.ACTION_REWIND.equals(action)) {
            service.seekBy(-15000);
        } else if (MediaSessionActions.ACTION_FAST_FORWARD.equals(action)) {
            service.seekBy(15000);
        }
    }

    @Override
    public boolean onMediaButtonEvent(Intent mediaButtonEvent) {
        // Handle media button event, return true if handled
        return super.onMediaButtonEvent(mediaButtonEvent);
    }
}
