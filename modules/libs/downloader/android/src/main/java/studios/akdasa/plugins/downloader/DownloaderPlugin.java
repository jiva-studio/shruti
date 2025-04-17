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
    private PluginCall onDownloadCompleteCallback;

    /* -------------------------------------------------------------------------- */
    /*                                  Lifecycle                                 */
    /* -------------------------------------------------------------------------- */

    public void load() {
        Log.i(TAG, "Starting...");
        Context context = getContext();
        this.implementation = new Downloader(
                context,
                (DownloadManager)context.getSystemService(Context.DOWNLOAD_SERVICE),
                new MyDownloadListener()
        );
    }

    @Override
    protected void handleOnDestroy() {
        Log.i(TAG, "Destroying...");
        implementation.close();
        super.handleOnDestroy();
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Methods                                  */
    /* -------------------------------------------------------------------------- */

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

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onDownloadComplete(PluginCall call) {
        // TODO: Currently, onDownloadComplete stores only one callback which will be overwritten
        //       if multiple callbacks are registered; consider using a collection to support
        //       multiple simultaneous download complete callbacks.
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        onDownloadCompleteCallback = call;
    }


    /* -------------------------------------------------------------------------- */
    /*                                   Private                                  */
    /* -------------------------------------------------------------------------- */

    private class MyDownloadListener implements Downloader.DownloadListener {
        @Override
        public void onDownloadCompleted(long taskId, String status) {
            if (onDownloadCompleteCallback == null) { return; }
            JSObject result = new JSObject();
            result.put("taskId", Long.toString(taskId));
            result.put("status", status);
            onDownloadCompleteCallback.resolve(result);
        }
    }
}