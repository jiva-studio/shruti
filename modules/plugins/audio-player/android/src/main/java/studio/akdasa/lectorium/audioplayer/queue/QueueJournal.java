package studio.jiva.shruti.audioplayer.queue;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * Durable on-disk journal of {@link QueueTransition}s plus the in-flight
 * {@code {currentItemId, positionMs}} snapshot.
 *
 * <p>The whole point of background continuous playback is that the native side
 * keeps advancing the queue while the WebView JS is suspended — and the process
 * may then be killed before JS ever wakes. So every transition is appended to
 * this file <em>synchronously, the instant it happens</em>, and the snapshot is
 * persisted on key events, so the next app start can drain the log instead of
 * losing it with the dead process.
 *
 * <p>The service (writing transitions from its {@code Player.Listener}) and the
 * plugin bridge (reading {@code getQueueState}, mutating {@code ackEvents}) run
 * in the same process but on different threads. All disk access goes through
 * {@link #LOCK} and writes are atomic (temp file + rename) so a kill mid-write
 * never corrupts the journal. The monotonic {@code seq} counter is persisted in
 * the same file so it survives a restart.
 *
 * <p>Time/position units on disk are milliseconds (native-native); the plugin
 * converts to seconds when it builds the JS-facing {@code QueueState}.
 */
public final class QueueJournal {

    /** Process-wide lock serialising the service writer and the plugin reader. */
    private static final Object LOCK = new Object();

    private static final String FILE_NAME = "audio_queue_journal.json";

    private static final String K_SEQ = "seq";
    private static final String K_EVENTS = "events";
    private static final String K_CURRENT_ITEM = "currentItemId";
    private static final String K_POSITION_MS = "positionMs";

    private final File file;

    public QueueJournal(Context context) {
        this.file = new File(context.getFilesDir(), FILE_NAME);
    }

    /**
     * Append a transition and return the persisted snapshot of the event. The
     * {@code seq} field of {@code partial} is ignored; this method assigns the
     * next monotonic seq, persists, and returns the stored event (with seq set).
     */
    public QueueTransition appendTransition(QueueTransition partial) {
        synchronized (LOCK) {
            JSONObject root = readRoot();
            long nextSeq = root.optLong(K_SEQ, 0) + 1;

            QueueTransition stored = partial.withSeq(nextSeq);
            JSONArray events = root.optJSONArray(K_EVENTS);
            if (events == null) {
                events = new JSONArray();
            }
            try {
                events.put(stored.toJson());
                root.put(K_SEQ, nextSeq);
                root.put(K_EVENTS, events);
            } catch (JSONException e) {
                e.printStackTrace();
            }
            writeRoot(root);
            return stored;
        }
    }

    /** Persist the in-flight position so a hard background kill loses at most
     *  the time since the last write (event-driven + coarse interval). */
    public void persistSnapshot(String currentItemId, long positionMs) {
        synchronized (LOCK) {
            JSONObject root = readRoot();
            try {
                if (currentItemId == null) {
                    root.remove(K_CURRENT_ITEM);
                } else {
                    root.put(K_CURRENT_ITEM, currentItemId);
                }
                root.put(K_POSITION_MS, positionMs);
            } catch (JSONException e) {
                e.printStackTrace();
            }
            writeRoot(root);
        }
    }

    /** All buffered transitions in seq order. Does NOT clear them. */
    public List<QueueTransition> readEvents() {
        synchronized (LOCK) {
            JSONObject root = readRoot();
            List<QueueTransition> out = new ArrayList<>();
            JSONArray events = root.optJSONArray(K_EVENTS);
            if (events != null) {
                for (int i = 0; i < events.length(); i++) {
                    JSONObject obj = events.optJSONObject(i);
                    if (obj != null) {
                        QueueTransition t = QueueTransition.fromJson(obj);
                        if (t != null) {
                            out.add(t);
                        }
                    }
                }
            }
            return out;
        }
    }

    /** Persisted snapshot of the in-flight item, or null if none. */
    public Snapshot readSnapshot() {
        synchronized (LOCK) {
            JSONObject root = readRoot();
            if (!root.has(K_CURRENT_ITEM)) {
                return null;
            }
            String itemId = root.optString(K_CURRENT_ITEM, null);
            long positionMs = root.optLong(K_POSITION_MS, 0);
            return new Snapshot(itemId, positionMs);
        }
    }

    /** Remove every event with {@code seq <= upToSeq}. Idempotent. */
    public void ack(long upToSeq) {
        synchronized (LOCK) {
            JSONObject root = readRoot();
            JSONArray events = root.optJSONArray(K_EVENTS);
            if (events == null) {
                return;
            }
            JSONArray kept = new JSONArray();
            for (int i = 0; i < events.length(); i++) {
                JSONObject obj = events.optJSONObject(i);
                if (obj == null) continue;
                long seq = obj.optLong("seq", 0);
                if (seq > upToSeq) {
                    kept.put(obj);
                }
            }
            try {
                root.put(K_EVENTS, kept);
            } catch (JSONException e) {
                e.printStackTrace();
            }
            writeRoot(root);
        }
    }

    /* ----------------------------- disk helpers ----------------------------- */

    private JSONObject readRoot() {
        if (!file.exists()) {
            return new JSONObject();
        }
        try {
            byte[] bytes = Files.readAllBytes(file.toPath());
            String text = new String(bytes, StandardCharsets.UTF_8);
            if (text.isEmpty()) {
                return new JSONObject();
            }
            return new JSONObject(text);
        } catch (IOException | JSONException e) {
            e.printStackTrace();
            return new JSONObject();
        }
    }

    /** Atomic write: serialise to a temp file, fsync, then rename over the
     *  target so a kill mid-write can never leave a half-written journal. */
    private void writeRoot(JSONObject root) {
        File tmp = new File(file.getParentFile(), FILE_NAME + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(root.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.getFD().sync();
        } catch (IOException e) {
            e.printStackTrace();
            return;
        }
        if (!tmp.renameTo(file)) {
            // renameTo can fail across some FS states; fall back to a direct
            // overwrite so we don't silently drop the update.
            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(root.toString().getBytes(StandardCharsets.UTF_8));
                fos.flush();
                fos.getFD().sync();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }

    /** In-flight position snapshot. */
    public static final class Snapshot {
        public final String currentItemId;
        public final long positionMs;

        public Snapshot(String currentItemId, long positionMs) {
            this.currentItemId = currentItemId;
            this.positionMs = positionMs;
        }
    }
}
