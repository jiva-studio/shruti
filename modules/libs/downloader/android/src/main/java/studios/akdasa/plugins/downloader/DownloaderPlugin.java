package studios.akdasa.plugins.downloader;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

@CapacitorPlugin(name = "Downloader")
public class DownloaderPlugin extends Plugin {
    private static final String TAG = "DownloaderPlugin";
    private Downloader implementation;

    public void load() {
        this.implementation = new Downloader(
                (DownloadManager)getContext().getSystemService(Context.DOWNLOAD_SERVICE)
        );
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String url = call.getString("url");
        String destination = call.getString("destination");
        String title = call.getString("title");

        // Validate inputs

        if (url == null || url.isBlank()) {
            call.reject("'url' is required");
            return;
        }

        if (destination == null || destination.isBlank()) {
            call.reject("'destination' is required");
            return;
        }

        if (title == null || title.isBlank()) {
            call.reject("'title' is required");
            return;
        }

        // Enqueue enqueue
        try {
            File directory = getContext().getExternalFilesDir(".");
            Uri localUrl = Uri.fromFile(new File(directory, destination));

            // Return task ID

            long taskId = implementation.enqueue(Uri.parse(url), localUrl, title);
            Log.d(TAG, "downloadFile: Method called");
            JSObject ret = new JSObject();
            ret.put("taskId", Long.toString(taskId));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Unable to download file", e);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        String taskId = call.getString("taskId");

        if (taskId == null || taskId.isBlank()) {
            call.reject("'taskId' is required");
            return;
        }

        try {
            String status = implementation.getStatus(Long.parseLong(taskId));
            JSObject ret = new JSObject();
            ret.put("status", status);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Unable to get status", e);
        }
    }
}