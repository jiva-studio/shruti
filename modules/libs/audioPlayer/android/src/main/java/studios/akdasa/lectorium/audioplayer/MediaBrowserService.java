package studios.akdasa.lectorium.audioplayer;

import android.os.Bundle;
import android.support.v4.media.MediaBrowserCompat;

import androidx.annotation.NonNull;
import androidx.media.MediaBrowserServiceCompat;

import java.util.ArrayList;
import java.util.List;

public class MediaBrowserService extends MediaBrowserServiceCompat {
    @Override
    public BrowserRoot onGetRoot(@NonNull String clientPackageName, int clientUid, Bundle rootHints) {
        // Return the root ID of your content hierarchy or null to deny browsing.
        return new BrowserRoot("root", null);
    }

    @Override
    public void onLoadChildren(@NonNull String parentId, @NonNull Result<List<MediaBrowserCompat.MediaItem>> result) {
        // Load the media items for the given parentId.
        result.sendResult(new ArrayList<MediaBrowserCompat.MediaItem>());
    }
}