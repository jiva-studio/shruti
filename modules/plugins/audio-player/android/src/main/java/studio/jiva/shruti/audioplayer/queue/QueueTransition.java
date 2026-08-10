package studio.jiva.shruti.audioplayer.queue;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * One item finishing and (maybe) the next starting. Native appends one of these
 * to {@link QueueJournal} the instant it happens. Units here are milliseconds /
 * epoch-millis (native-native); the plugin converts to seconds for JS.
 *
 * <p>Only {@link #REASON_AUTO} (a natural end) means the finished item was
 * completed. A skip or an error finishes the item at {@link #finishedAtMs} which
 * is &lt; {@link #durationMs}.
 */
public final class QueueTransition {

    public static final String REASON_AUTO = "auto";
    public static final String REASON_SKIP_NEXT = "skip-next";
    public static final String REASON_SKIP_PREV = "skip-prev";
    public static final String REASON_ERROR = "error";

    public final String finishedItemId;
    public final long fromPositionMs;
    public final long finishedAtMs;
    public final long durationMs;
    public final String startedItemId; // null when the queue ran dry
    public final String reason;
    public final long atEpochMs;
    /** Wall-clock when listening on this item began — the {@link #fromPositionMs}
     *  counterpart, so JS gets the run's real span instead of one estimated from
     *  the audio span at 1×. 0 means "not stamped" (an entry an older build left
     *  in the durable journal). */
    public final long fromAtEpochMs;
    public final long seq;

    public QueueTransition(
            String finishedItemId,
            long fromPositionMs,
            long finishedAtMs,
            long durationMs,
            String startedItemId,
            String reason,
            long atEpochMs,
            long fromAtEpochMs,
            long seq) {
        this.finishedItemId = finishedItemId;
        this.fromPositionMs = fromPositionMs;
        this.finishedAtMs = finishedAtMs;
        this.durationMs = durationMs;
        this.startedItemId = startedItemId;
        this.reason = reason;
        this.atEpochMs = atEpochMs;
        this.fromAtEpochMs = fromAtEpochMs;
        this.seq = seq;
    }

    public QueueTransition withSeq(long newSeq) {
        return new QueueTransition(
                finishedItemId, fromPositionMs, finishedAtMs, durationMs,
                startedItemId, reason, atEpochMs, fromAtEpochMs, newSeq);
    }

    public JSONObject toJson() throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("finishedItemId", finishedItemId == null ? "" : finishedItemId);
        obj.put("fromPositionMs", fromPositionMs);
        obj.put("finishedAtMs", finishedAtMs);
        obj.put("durationMs", durationMs);
        if (startedItemId == null) {
            obj.put("startedItemId", JSONObject.NULL);
        } else {
            obj.put("startedItemId", startedItemId);
        }
        obj.put("reason", reason);
        obj.put("at", atEpochMs);
        // Omitted when unstamped, so JS sees `undefined` and takes the estimate.
        if (fromAtEpochMs > 0) {
            obj.put("fromAt", fromAtEpochMs);
        }
        obj.put("seq", seq);
        return obj;
    }

    public static QueueTransition fromJson(JSONObject obj) {
        if (obj == null) return null;
        String started = obj.isNull("startedItemId") ? null : obj.optString("startedItemId", null);
        return new QueueTransition(
                obj.optString("finishedItemId", ""),
                obj.optLong("fromPositionMs", 0),
                obj.optLong("finishedAtMs", 0),
                obj.optLong("durationMs", 0),
                started,
                obj.optString("reason", REASON_AUTO),
                obj.optLong("at", 0),
                // Absent in a journal file written before this field existed.
                obj.optLong("fromAt", 0),
                obj.optLong("seq", 0));
    }
}
