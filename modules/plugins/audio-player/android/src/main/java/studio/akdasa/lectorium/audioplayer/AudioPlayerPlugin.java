package studio.jiva.shruti.audioplayer;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;


@CapacitorPlugin(name="AudioPlayer")
public final class AudioPlayerPlugin extends Plugin {
    private final AudioPlayerServiceConnection audioPlayerServiceConnection = new AudioPlayerServiceConnection();

    /* -------------------------------------------------------------------------- */
    /*                             Lifecycle methods                              */
    /* -------------------------------------------------------------------------- */

    @Override
    public void load() {
        Intent intent = new Intent(getContext(), AudioPlayerService.class);
        getContext().bindService(intent, audioPlayerServiceConnection, Context.BIND_AUTO_CREATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        }
    }

    @Override
    protected void handleOnDestroy() {
        // Stop playback and clean up when plugin is destroyed
        if (audioPlayerServiceConnection.isConnected()) {
            audioPlayerServiceConnection.getService().stop();
        }

        // Stop and unbind audio player service
        Intent intent = new Intent(getContext(), AudioPlayerService.class);
        getContext().unbindService(audioPlayerServiceConnection);
        getContext().stopService(intent);
        super.handleOnDestroy();
    }

    
    /* -------------------------------------------------------------------------- */
    /*                               Plugin methods                               */
    /* -------------------------------------------------------------------------- */

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String trackId = call.getString("itemId");
        String title = call.getString("title", "");
        String author = call.getString("author", "");

        // Validate input arguments
        if (url == null) {
            call.reject("Argument 'url' is required");
            return;
        }

        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }

        // Start playing
        audioPlayerServiceConnection
          .getService()
          .open(trackId, url, title, author);
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        audioPlayerServiceConnection.getService().play();
        call.resolve();
    }

    @PluginMethod
    public void togglePause(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        audioPlayerServiceConnection.getService().togglePause();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        Float position = call.getFloat("position", 0.0f);
        if (position == null) { return; }
        audioPlayerServiceConnection.getService().seek((long)(position * 1000.0));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        audioPlayerServiceConnection.getService().stop();
        call.resolve();
    }

    @PluginMethod
    public void seekBy(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        Float delta = call.getFloat("delta", 0.0f);
        if (delta == null) {
            call.reject("Argument 'delta' is required");
            return;
        }
        audioPlayerServiceConnection.getService().seekBy((long)(delta * 1000.0));
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackRate(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        Float rate = call.getFloat("rate", 1.0f);
        if (rate == null) {
            call.reject("Argument 'rate' is required");
            return;
        }
        // Clamp on the bridge to match the JS side; ExoPlayer would accept
        // wider values but speech beyond ±2× rarely makes sense.
        if (rate < 0.5f) rate = 0.5f;
        if (rate > 2.0f) rate = 2.0f;
        audioPlayerServiceConnection.getService().setPlaybackRate(rate);
        call.resolve();
    }

    @PluginMethod
    public void setMix(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        Boolean enabled = call.getBoolean("enabled", false);
        Float ratio = call.getFloat("ratio", 0.5f);
        if (enabled == null || ratio == null) {
            call.reject("Arguments 'enabled' and 'ratio' are required");
            return;
        }
        audioPlayerServiceConnection.getService().setMix(enabled, ratio);
        call.resolve();
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onProgressChanged(PluginCall call) {
        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        audioPlayerServiceConnection.getService().setOnProgressChangeCall(call);
    }
}
