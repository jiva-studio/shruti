package studios.akdasa.lectorium.audioplayer;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;


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
        // If audio service started and playing, just keep it playing.
        boolean isConnectedAndPlaying =
                audioPlayerServiceConnection.isConnected() &&
                audioPlayerServiceConnection.getService().getMediaPlayer().isPlaying();
        if (isConnectedAndPlaying) { return; }

        // Stop audio player service if it is not playing
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
        String trackId = call.getString("trackId");
        String title = call.getString("title");
        String author = call.getString("author");

        // Validate input arguments
        if (url == null) {
            call.reject("Argument 'url' is required");
            return;
        }

        if (!audioPlayerServiceConnection.isConnected()) {
            call.reject("Audio service is not started");
            return;
        }

        // Convert url to local path
        File directory = getContext().getExternalFilesDir(".");
        Uri localUrl = Uri.fromFile(new File(directory, url));

        // Start playing
        audioPlayerServiceConnection
          .getService()
          .open(trackId, localUrl.toString(), title, author);
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        audioPlayerServiceConnection.getService().play();
        call.resolve();
    }

    @PluginMethod
    public void togglePause(PluginCall call) {
        audioPlayerServiceConnection.getService().togglePause();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Float position = call.getFloat("position", 0.0f);
        if (position == null) { return; }
        audioPlayerServiceConnection.getService().seek(position.longValue() * 1000);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        audioPlayerServiceConnection.getService().stop();
        call.resolve();
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onProgressChanged(PluginCall call) {
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        audioPlayerServiceConnection.getService().setOnProgressChangeCall(call);
    }
}
