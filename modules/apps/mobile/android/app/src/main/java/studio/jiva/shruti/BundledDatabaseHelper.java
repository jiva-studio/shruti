package studio.jiva.shruti;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

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
 *
 * Keep in lockstep with ios/App/App/BundledDatabaseHelper.swift — the two
 * implement the same predicate and drift between them is a boot-time bug on
 * one platform only.
 */
public class BundledDatabaseHelper {

    private static final String DEFAULT_TARGET_SUBDIR = "shruti/databases";
    private static final String TEMP_SUFFIX = ".copying";

    /**
     * First bytes of every SQLite file. Same gate as the JS side applies in
     * {@code infra/persistence/fetchers/fs/useDatabaseToFsFetcher.ts}
     * ("SQLite format 3\0" + a minimum size of those 16 bytes), so a file this
     * helper keeps is a file the JS resolver will also accept.
     */
    private static final byte[] SQLITE_MAGIC_HEADER =
            "SQLite format 3\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII);

    private final Context context;

    public BundledDatabaseHelper(Context context) {
        this.context = context;
    }

    private String getTargetSubdir() {
        int resId = context.getResources().getIdentifier("database_target_subdir", "string", context.getPackageName());
        if (resId != 0) {
            return context.getString(resId);
        }
        int appNameId = context.getResources().getIdentifier("app_name_slug", "string", context.getPackageName());
        if (appNameId != 0) {
            return context.getString(appNameId) + "/databases";
        }
        return DEFAULT_TARGET_SUBDIR;
    }

    /**
     * Copies every .db file found in {@code assets/databases/} to
     * {@code getFilesDir()/<targetSubdir>/}, unless the device already
     * holds a usable catalog at least as new as the bundled one.
     *
     * The old rule was "skip when a file with this exact name exists", which
     * lost a fight with the JS bootstrap: `pruneSuperseded` deletes every
     * catalog older than the one it opened, and the bundled file is the oldest
     * by construction. Once any newer catalog had been downloaded the two
     * ping-ponged — prune each launch, a ~54 MB inflate-from-assets on the main
     * thread the next cold start, forever (#1830).
     */
    public void copyBundledDatabases() {
        try {
            String[] assets = context.getAssets().list(ASSETS_DIR);
            if (assets == null || assets.length == 0) {
                return;
            }

            File targetDir = new File(context.getFilesDir(), getTargetSubdir());
            if (!targetDir.exists()) {
                targetDir.mkdirs();
            }

            String[] onDisk = targetDir.list();
            if (onDisk == null) {
                onDisk = new String[0];
            }

            for (String fileName : assets) {
                if (!fileName.endsWith(".db")) {
                    continue;
                }

                if (!shouldCopy(fileName, onDisk, targetDir)) {
                    Log.d(TAG, "Usable catalog already on disk, skipping: " + fileName);
                    continue;
                }

                File targetFile = new File(targetDir, fileName);
                copyAsset(ASSETS_DIR + "/" + fileName, targetFile);
                Log.i(TAG, "Copied bundled database: " + fileName
                        + " (" + targetFile.length() + " bytes)");
            }
        } catch (IOException e) {
            // No bundled databases in assets — normal for non-bundled builds
            Log.d(TAG, "No bundled databases found: " + e.getMessage());
        }
    }

    /**
     * Whether the bundled {@code assetName} still has to be written to disk.
     *
     * Copy iff no on-disk file matching {@code ^<stem>\.(\d+)\.db$} has a
     * version &ge; the asset's AND passes the integrity gate. That is the exact
     * complement of the JS prune rule (kit
     * {@code bootstrap/contentDatabaseResolver.ts#pruneContentDatabases}, which
     * keeps versions &ge; the one it opened), so the two can never fight:
     * an equal or older bundled catalog is skipped, a NEWER bundled catalog —
     * an app update shipping a fresher one — is copied and prune then drops the
     * stale on-disk file.
     *
     * The version test alone would also skip when the newer file on disk is
     * truncated or not a database at all, throwing away a good fallback; hence
     * the header check on the candidate that would justify the skip.
     */
    private static boolean shouldCopy(String assetName, String[] onDisk, File targetDir) {
        String stem = versionStem(assetName);
        long assetVersion = parseVersion(assetName, stem);
        if (assetVersion < 0) {
            // Asset is not versioned — nothing to compare, fall back to
            // "copy unless a usable file of the same name is already there".
            return !isUsableDatabase(new File(targetDir, assetName));
        }

        for (String candidate : onDisk) {
            long version = parseVersion(candidate, stem);
            if (version < assetVersion) {
                continue;
            }
            if (isUsableDatabase(new File(targetDir, candidate))) {
                return false;
            }
        }
        return true;
    }

    /** {@code "shruti.42.db"} → {@code "shruti"}; the name itself when unversioned. */
    private static String versionStem(String fileName) {
        int dot = fileName.indexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    /**
     * Version in {@code <stem>.<digits>.db}, or {@code -1} when it does not match.
     *
     * A catalog version is a 14-digit {@code YYYYMMDDHHmmss} stamp, four orders of
     * magnitude past {@code Integer.MAX_VALUE} — parsing it as an {@code int} threw
     * on every real filename, so the caller saw {@code -1} and skipped the whole
     * version comparison.
     */
    private static long parseVersion(String fileName, String stem) {
        String prefix = stem + ".";
        String suffix = ".db";
        if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) {
            return -1;
        }
        if (fileName.length() <= prefix.length() + suffix.length()) {
            return -1;
        }
        String digits = fileName.substring(prefix.length(), fileName.length() - suffix.length());
        for (int i = 0; i < digits.length(); i++) {
            if (digits.charAt(i) < '0' || digits.charAt(i) > '9') {
                return -1;
            }
        }
        try {
            return Long.parseLong(digits);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** SQLite magic header + at least header-many bytes — the JS side's gate, verbatim. */
    private static boolean isUsableDatabase(File file) {
        if (!file.isFile() || file.length() < SQLITE_MAGIC_HEADER.length) {
            return false;
        }
        byte[] header = new byte[SQLITE_MAGIC_HEADER.length];
        try (InputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < header.length) {
                int n = in.read(header, read, header.length - read);
                if (n < 0) {
                    return false;
                }
                read += n;
            }
        } catch (IOException e) {
            return false;
        }
        for (int i = 0; i < header.length; i++) {
            if (header[i] != SQLITE_MAGIC_HEADER[i]) {
                return false;
            }
        }
        return true;
    }

    /**
     * Streams the asset to a temp neighbour and renames it into place, so a
     * process kill or a full disk mid-copy can never leave a truncated file at
     * the canonical name — which the header-only gate above (and the JS one)
     * would happily accept. The temp name does not match the versioned pattern,
     * so a leftover is invisible to this predicate and to the JS prune; the JS
     * side sweeps {@code *.copying} alongside the prune instead (#1896).
     */
    private void copyAsset(String assetPath, File targetFile) throws IOException {
        File tempFile = new File(targetFile.getParentFile(), targetFile.getName() + TEMP_SUFFIX);
        if (tempFile.exists() && !tempFile.delete()) {
            throw new IOException("Cannot remove stale temp file " + tempFile.getName());
        }

        try {
            try (InputStream in = context.getAssets().open(assetPath);
                 FileOutputStream out = new FileOutputStream(tempFile)) {
                byte[] buffer = new byte[8192];
                int len;
                while ((len = in.read(buffer)) > 0) {
                    out.write(buffer, 0, len);
                }
                out.flush();
                // Durability before the rename: without it the rename can land
                // ahead of the data and a power loss re-creates the very
                // truncated-file case the temp copy exists to prevent.
                out.getFD().sync();
            }
            if (!tempFile.renameTo(targetFile)) {
                throw new IOException("Cannot move " + tempFile.getName() + " into place");
            }
        } finally {
            if (tempFile.exists()) {
                tempFile.delete();
            }
        }
    }
}
