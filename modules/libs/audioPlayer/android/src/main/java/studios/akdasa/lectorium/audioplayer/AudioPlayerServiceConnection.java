package studios.akdasa.lectorium.audioplayer;

import android.content.ComponentName;
import android.content.ServiceConnection;
import android.os.IBinder;

public final class AudioPlayerServiceConnection implements ServiceConnection {
    private AudioPlayerService audioPlayerService;

    public AudioPlayerService getService() {
        return this.audioPlayerService;
    }

    public boolean isConnected() {
        return this.audioPlayerService != null;
    }

    @Override
    public void onServiceConnected(ComponentName className, IBinder service) {
        AudioPlayerServiceBinder binder = (AudioPlayerServiceBinder) service;
        audioPlayerService = binder.getService();
    }

    @Override
    public void onServiceDisconnected(ComponentName className) {
        audioPlayerService = null;
    }
}
