package studios.akdasa.plugins.downloader;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;


public class Downloader implements AutoCloseable {
    private static final String TAG = "DownloaderPlugin";
    private final DownloadManager downloadManager;
    private final DownloadCompleteReceiver downloadCompleteReceiver;
    private final Context context;
    private final DownloadListener downloadListener;

    public Downloader(
            Context context,
            DownloadManager downloadManager,
            DownloadListener downloadListener
    ) {
        this.context = context;
        this.downloadManager = downloadManager;
        this.downloadListener = downloadListener;
        this.downloadCompleteReceiver = new DownloadCompleteReceiver();

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // API 33 and above
            context.registerReceiver(
                    downloadCompleteReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            // API 26 to 32
            ContextCompat.registerReceiver(
                    context, downloadCompleteReceiver, filter,
                    ContextCompat.RECEIVER_EXPORTED);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Interfaces                                 */
    /* -------------------------------------------------------------------------- */

    public interface DownloadListener {
        void onDownloadCompleted(long taskId, String status);
    }


    /* -------------------------------------------------------------------------- */
    /*                                   Methods                                  */
    /* -------------------------------------------------------------------------- */

    /**
     * Enqueue a download request.
     * @param remoteUri The URI of the file to download.
     * @param localPath The URI where the file will be saved.
     * @param title The title of the download.
     */
    public long enqueue(
      Uri remoteUri,
      Uri localPath,
      String title
    ) {
      return downloadManager.enqueue(
              new DownloadManager.Request(remoteUri)
                      .setDestinationUri(localPath)
                      .setTitle(title)
      );
    }

    /**
     * Get the status of a download.
     * @param taskId The ID of the download to check.
     * @return The status of the download as a string.
     */
    public String getStatus(long taskId) {
        Cursor cursor = downloadManager.query(
                new DownloadManager.Query().setFilterById(taskId)
        );
        if (cursor != null) {
            if (cursor.moveToFirst()) {
                int columnIndex = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS);
                int status = cursor.getInt(columnIndex);
                cursor.close();
                return switch (status) {
                    case DownloadManager.STATUS_SUCCESSFUL -> "successful";
                    case DownloadManager.STATUS_PENDING -> "pending";
                    case DownloadManager.STATUS_PAUSED -> "paused";
                    case DownloadManager.STATUS_RUNNING -> "running";
                    default -> "failed";
                };
            }
            cursor.close();
        }

        return "failed";
    }

    /**
     * Close the downloader and unregister the receiver.
     * This should be called when the downloader is no longer needed.
     */
    @Override
    public void close() {
        context.unregisterReceiver(downloadCompleteReceiver);
    }


    /* -------------------------------------------------------------------------- */
    /*                                   Private                                  */
    /* -------------------------------------------------------------------------- */

    class DownloadCompleteReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                long taskId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (taskId == -1) { return; }
                String status = getStatus(taskId);
                downloadListener.onDownloadCompleted(taskId, status);
            }
        }
    }
}
