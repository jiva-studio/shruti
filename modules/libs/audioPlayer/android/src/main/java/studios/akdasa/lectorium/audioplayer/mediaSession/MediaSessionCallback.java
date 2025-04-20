package studios.akdasa.lectorium.audioplayer.mediaSession;

import android.content.Intent;
import android.support.v4.media.session.MediaSessionCompat;

import studios.akdasa.lectorium.audioplayer.AudioPlayerService;

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
    public boolean onMediaButtonEvent(Intent mediaButtonEvent) {
        // Handle media button event, return true if handled
        return super.onMediaButtonEvent(mediaButtonEvent);
    }
}
