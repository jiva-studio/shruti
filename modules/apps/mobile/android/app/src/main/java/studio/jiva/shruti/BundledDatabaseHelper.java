package studio.jiva.shruti;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Copies bundled database files from APK assets to the app's internal
 * storage so they are available to the Capacitor SQLite plugin on
 * first launch without a network download.
 *
 * Expected asset location: assets/databases/*.db
 * Target location: getFilesDir()/shruti/databases/*.db
 *
 * The target path matches what {@code @capacitor-community/sqlite}
 * resolves for NC connections via {@code getFilesDir()} and what
 * {@code @capacitor/filesystem} Directory.Data maps to on Android.
 */
public class BundledDatabaseHelper {

    private static final String TAG = "BundledDatabaseHelper";
    private static final String ASSETS_DIR = "databases";
    private static final String TARGET_SUBDIR = "shruti/databases";

    private final Context context;

    public BundledDatabaseHelper(Context context) {
        this.context = context;
    }

    /**
     * Copies every .db file found in {@code assets/databases/} to
     * {@code getFilesDir()/shruti/databases/}. Files that already
     * exist at the target are skipped (idempotent).
     */
    public void copyBundledDatabases() {
        try {
            String[] files = context.getAssets().list(ASSETS_DIR);
            if (files == null || files.length == 0) {
                return;
            }

            File targetDir = new File(context.getFilesDir(), TARGET_SUBDIR);
            if (!targetDir.exists()) {
                targetDir.mkdirs();
            }

            for (String fileName : files) {
                if (!fileName.endsWith(".db")) {
                    continue;
                }

                File targetFile = new File(targetDir, fileName);
                if (targetFile.exists()) {
                    Log.d(TAG, "Already exists, skipping: " + fileName);
                    continue;
                }

                copyAsset(ASSETS_DIR + "/" + fileName, targetFile);
                Log.i(TAG, "Copied bundled database: " + fileName
                        + " (" + targetFile.length() + " bytes)");
            }
        } catch (IOException e) {
            // No bundled databases in assets — normal for non-bundled builds
            Log.d(TAG, "No bundled databases found: " + e.getMessage());
        }
    }

    private void copyAsset(String assetPath, File targetFile) throws IOException {
        try (InputStream in = context.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(targetFile)) {
            byte[] buffer = new byte[8192];
            int len;
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
            }
        }
    }
}
