package studios.akdasa.plugins.downloader;

import android.app.DownloadManager;
import android.database.Cursor;
import android.net.Uri;


public class Downloader {
    private final DownloadManager downloadManager;

    public Downloader(
            DownloadManager downloadManager
    ) {
        this.downloadManager = downloadManager;
    }

    public long enqueue(
      Uri remoteUri,
      Uri localUri,
      String title
    ) {
      return downloadManager.enqueue(
              new DownloadManager.Request(remoteUri)
                      .setDestinationUri(localUri)
                      .setTitle(title)
      );
    }

    public String getStatus(long downloadId) {
        DownloadManager.Query query = new DownloadManager.Query();
        query.setFilterById(downloadId);

        Cursor cursor = downloadManager.query(query);
        if (cursor != null) {
            if (cursor.moveToFirst()) {
                int columnIndex = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS);
                int status = cursor.getInt(columnIndex);
                cursor.close();
                return switch (status) {
                    case DownloadManager.STATUS_SUCCESSFUL -> "successful";
                    case DownloadManager.STATUS_PENDING -> "pending";
                    case DownloadManager.STATUS_PAUSED -> "paused";
                    case DownloadManager.STATUS_FAILED -> "failed";
                    case DownloadManager.STATUS_RUNNING -> "running";
                    default -> "unknown";
                };
            }
            cursor.close();
        }

        return "not-found";
    }
}
