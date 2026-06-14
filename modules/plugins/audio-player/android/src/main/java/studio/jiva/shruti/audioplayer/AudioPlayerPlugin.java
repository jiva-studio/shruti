package studio.jiva.shruti.audioplayer;

import android.content.ComponentName;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;

import studio.jiva.shruti.audioplayer.queue.QueueJournal;
import studio.jiva.shruti.audioplayer.queue.QueueTransition;

/**
 * Capacitor bridge for the audio player. The plugin process holds a Media3
 * {@link MediaController} that connects to {@link AudioPlayerService} (a
 * {@link androidx.media3.session.MediaSessionService}). The controller mirrors
 * the {@link Player} interface on the main thread and keeps the service alive
 * for as long as it is connected.
 *
 * <p>Progress is emitted to JS the same way as before — a ~500ms poll posts a
 * Status-shaped {@code {itemId, playing, position, duration}} (positions in
 * seconds) to the saved {@code onProgressChanged} callback. Media3 owns the
 * lock-screen notification, so there is no hand-built notification loop anymore.
 */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "AudioPlayer")
public final class AudioPlayerPlugin extends Plugin {

    private static final long PROGRESS_INTERVAL_MS = 500L;
    /** Minimum emit cadence — guards against a runaway 2 Hz+ stream. */
    private static final long MIN_PROGRESS_INTERVAL_MS = 250L;

    private ListenableFuture<MediaController> controllerFuture;
    private MediaController controller;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private PluginCall progressCall;
    // Mutable so `setProgressInterval` can adapt the JS-bridge cadence
    // (e.g. a slow heartbeat while backgrounded). The system notification
    // updates independently via Media3, so this only governs the WebView push.
    private volatile long progressIntervalMs = PROGRESS_INTERVAL_MS;
    private PluginCall transitionCall;
    private QueueJournal journal;
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            emitProgress();
            mainHandler.postDelayed(this, progressIntervalMs);
        }
    };

    /* -------------------------------------------------------------------------- */
    /*                             Lifecycle methods                              */
    /* -------------------------------------------------------------------------- */

    @Override
    public void load() {
        journal = new QueueJournal(getContext());
        SessionToken token = new SessionToken(
                getContext(),
                new ComponentName(getContext(), AudioPlayerService.class));
        controllerFuture = new MediaController.Builder(getContext(), token).buildAsync();
        controllerFuture.addListener(() -> {
            try {
                controller = controllerFuture.get();
                // Best-effort foreground push: when the controller observes an
                // item transition, surface the latest journal entry to JS. The
                // durable journal drained via getQueueState() is the source of
                // truth; this is just instant UI in the foreground.
                controller.addListener(new Player.Listener() {
                    @Override
                    public void onMediaItemTransition(MediaItem item, int reason) {
                        pushLatestTransition();
                    }
                });
                mainHandler.post(progressTick);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }, MoreExecutors.directExecutor());
    }

    @Override
    protected void handleOnDestroy() {
        mainHandler.removeCallbacks(progressTick);
        if (controllerFuture != null) {
            MediaController.releaseFuture(controllerFuture);
            controllerFuture = null;
        }
        controller = null;
        super.handleOnDestroy();
    }

    private boolean ensureController(PluginCall call) {
        if (controller == null) {
            call.reject("Audio service is not connected");
            return false;
        }
        return true;
    }

    /* -------------------------------------------------------------------------- */
    /*                               Plugin methods                               */
    /* -------------------------------------------------------------------------- */

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String itemId = call.getString("itemId", "");
        String title = call.getString("title", "");
        String author = call.getString("author", "");
        String cover = call.getString("cover");

        if (url == null) {
            call.reject("Argument 'url' is required");
            return;
        }
        if (!ensureController(call)) {
            return;
        }

        // A single track is just a queue of length 1: route it through the SAME
        // setQueue path so there is one native play path (and the journal /
        // auto-advance machinery treats it identically).
        try {
            JSONArray items = new JSONArray();
            JSONObject o = new JSONObject();
            o.put("itemId", itemId);
            o.put("url", url);
            o.put("title", title);
            o.put("author", author);
            if (cover != null && !cover.isEmpty()) {
                o.put("cover", cover);
            }
            items.put(o);
            dispatchSetQueue(items.toString(), 0, 0L);
            call.resolve();
        } catch (JSONException e) {
            call.reject("Failed to build open item", e);
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        if (!ensureController(call)) return;
        mainHandler.post(() -> {
            controller.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void togglePause(PluginCall call) {
        if (!ensureController(call)) return;
        mainHandler.post(() -> {
            if (controller.isPlaying()) {
                controller.pause();
            } else {
                controller.play();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        if (!ensureController(call)) return;
        Float position = call.getFloat("position", 0.0f);
        if (position == null) {
            call.reject("Argument 'position' is required");
            return;
        }
        final long positionMs = (long) (position * 1000.0);
        mainHandler.post(() -> {
            controller.seekTo(positionMs);
            call.resolve();
        });
    }

    @PluginMethod
    public void seekBy(PluginCall call) {
        if (!ensureController(call)) return;
        Float delta = call.getFloat("delta", 0.0f);
        if (delta == null) {
            call.reject("Argument 'delta' is required");
            return;
        }
        final long deltaMs = (long) (delta * 1000.0);
        mainHandler.post(() -> {
            long current = controller.getCurrentPosition();
            long duration = controller.getDuration();
            long target = current + deltaMs;
            if (target < 0) target = 0;
            if (duration != C.TIME_UNSET && target > duration) target = duration;
            controller.seekTo(target);
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!ensureController(call)) return;
        mainHandler.post(() -> {
            controller.stop();
            controller.clearMediaItems();
            call.resolve();
        });
    }

    @PluginMethod
    public void setPlaybackRate(PluginCall call) {
        if (!ensureController(call)) return;
        Float rate = call.getFloat("rate", 1.0f);
        if (rate == null) {
            call.reject("Argument 'rate' is required");
            return;
        }
        // Clamp on the bridge to match the JS side; ExoPlayer would accept
        // wider values but speech beyond ±2× rarely makes sense.
        if (rate < 0.5f) rate = 0.5f;
        if (rate > 2.0f) rate = 2.0f;
        final float finalRate = rate;
        mainHandler.post(() -> {
            // pitch preserved (default pitch=1f) so a 2× lecture still sounds
            // human. Set on the player, so it survives item transitions.
            controller.setPlaybackParameters(new PlaybackParameters(finalRate));
            call.resolve();
        });
    }

    @PluginMethod
    public void setMix(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", false);
        Float ratio = call.getFloat("ratio", 0.5f);
        if (enabled == null || ratio == null) {
            call.reject("Arguments 'enabled' and 'ratio' are required");
            return;
        }
        if (!ensureController(call)) return;
        // The StereoMixAudioProcessor lives in the service's audio sink; the
        // controller reaches it through a session custom command.
        Bundle args = new Bundle();
        args.putBoolean("enabled", enabled);
        args.putFloat("ratio", ratio);
        mainHandler.post(() -> {
            controller.sendCustomCommand(
                    new SessionCommand(AudioPlayerService.ACTION_SET_MIX, Bundle.EMPTY), args);
            call.resolve();
        });
    }

    @PluginMethod
    public void setProgressInterval(PluginCall call) {
        Integer intervalMs = call.getInt("intervalMs");
        if (intervalMs == null) {
            call.reject("Argument 'intervalMs' is required");
            return;
        }
        // Adjust the JS-bridge poll cadence. The running tick picks up the new
        // value on its next reschedule; restart it so a long interval doesn't
        // delay the change. Media3 owns the lock-screen notification, so this
        // only governs the WebView push (unchanged contract from #828).
        progressIntervalMs = Math.max(MIN_PROGRESS_INTERVAL_MS, intervalMs.longValue());
        mainHandler.post(() -> {
            if (progressCall != null) {
                mainHandler.removeCallbacks(progressTick);
                mainHandler.post(progressTick);
            }
        });
        call.resolve();
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onProgressChanged(PluginCall call) {
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        progressCall = call;
    }

    /* -------------------------------------------------------------------------- */
    /*                               Queue methods                                */
    /* -------------------------------------------------------------------------- */

    @PluginMethod
    public void setQueue(PluginCall call) {
        if (!ensureController(call)) return;
        JSArray itemsArr = call.getArray("items");
        if (itemsArr == null) {
            call.reject("Argument 'items' is required");
            return;
        }
        int startIndex = call.getInt("startIndex", 0);
        Double startPosition = call.getDouble("startPosition", 0.0);
        long startPositionMs = (long) ((startPosition == null ? 0.0 : startPosition) * 1000.0);

        String itemsJson = buildItemsJson(itemsArr);
        if (itemsJson == null) {
            call.reject("Invalid 'items' payload");
            return;
        }
        dispatchSetQueue(itemsJson, startIndex, startPositionMs);
        call.resolve();
    }

    @PluginMethod
    public void appendToQueue(PluginCall call) {
        if (!ensureController(call)) return;
        JSArray itemsArr = call.getArray("items");
        if (itemsArr == null) {
            call.reject("Argument 'items' is required");
            return;
        }
        String itemsJson = buildItemsJson(itemsArr);
        if (itemsJson == null) {
            call.reject("Invalid 'items' payload");
            return;
        }
        Bundle args = new Bundle();
        args.putString("items", itemsJson);
        mainHandler.post(() -> {
            controller.sendCustomCommand(
                    new SessionCommand(AudioPlayerService.ACTION_APPEND_QUEUE, Bundle.EMPTY), args);
            call.resolve();
        });
    }

    @PluginMethod
    public void getQueueState(PluginCall call) {
        // Live now-playing state from the controller; the transition journal
        // from disk (the source of truth — survives a background kill). Reading
        // does NOT clear the journal; JS calls ackEvents() after persisting.
        mainHandler.post(() -> {
            JSObject result = new JSObject();
            String currentItemId = null;
            double position = 0;
            double duration = 0;
            boolean playing = false;
            if (controller != null) {
                MediaItem current = controller.getCurrentMediaItem();
                if (current != null && current.mediaId != null && !current.mediaId.isEmpty()) {
                    currentItemId = current.mediaId;
                }
                position = Math.max(0, controller.getCurrentPosition()) / 1000.0;
                long d = controller.getDuration();
                duration = (d == C.TIME_UNSET ? 0 : d) / 1000.0;
                playing = controller.isPlaying();
            }
            if (currentItemId == null) {
                // Fall back to the persisted snapshot when the controller has no
                // live item (e.g. process was killed and the queue ran dry).
                QueueJournal.Snapshot snap = journal.readSnapshot();
                if (snap != null) {
                    currentItemId = snap.currentItemId;
                    position = Math.max(0, snap.positionMs) / 1000.0;
                }
            }
            if (currentItemId == null) {
                result.put("currentItemId", JSObject.NULL);
            } else {
                result.put("currentItemId", currentItemId);
            }
            result.put("position", position);
            result.put("duration", duration);
            result.put("playing", playing);
            result.put("events", eventsToJsArray(journal.readEvents()));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void ackEvents(PluginCall call) {
        Integer upToSeq = call.getInt("upToSeq", 0);
        if (upToSeq == null) {
            call.reject("Argument 'upToSeq' is required");
            return;
        }
        journal.ack(upToSeq);
        call.resolve();
    }

    @PluginMethod
    public void skipToNext(PluginCall call) {
        if (!ensureController(call)) return;
        dispatchSkip(true);
        call.resolve();
    }

    @PluginMethod
    public void skipToPrevious(PluginCall call) {
        if (!ensureController(call)) return;
        dispatchSkip(false);
        call.resolve();
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void onItemTransition(PluginCall call) {
        call.setKeepAlive(true);
        getBridge().saveCall(call);
        transitionCall = call;
    }

    /* -------------------------------------------------------------------------- */
    /*                              Progress emission                             */
    /* -------------------------------------------------------------------------- */

    private void emitProgress() {
        if (progressCall == null || controller == null) {
            return;
        }
        MediaItem current = controller.getCurrentMediaItem();
        String itemId = current != null ? current.mediaId : "";
        long positionMs = controller.getCurrentPosition();
        long durationMs = controller.getDuration();

        JSObject payload = new JSObject();
        payload.put("itemId", itemId == null ? "" : itemId);
        payload.put("playing", controller.isPlaying());
        payload.put("position", Math.max(0, positionMs) / 1000.0);
        payload.put("duration", (durationMs == C.TIME_UNSET ? 0 : durationMs) / 1000.0);
        progressCall.resolve(payload);
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Helpers                                  */
    /* -------------------------------------------------------------------------- */

    private void dispatchSetQueue(String itemsJson, int startIndex, long startPositionMs) {
        Bundle args = new Bundle();
        args.putString("items", itemsJson);
        args.putInt("startIndex", startIndex);
        args.putLong("startPositionMs", startPositionMs);
        mainHandler.post(() -> {
            if (controller == null) return;
            controller.sendCustomCommand(
                    new SessionCommand(AudioPlayerService.ACTION_SET_QUEUE, Bundle.EMPTY), args);
        });
    }

    private void dispatchSkip(boolean next) {
        Bundle args = new Bundle();
        args.putBoolean("next", next);
        mainHandler.post(() -> {
            if (controller == null) return;
            controller.sendCustomCommand(
                    new SessionCommand(AudioPlayerService.ACTION_SKIP, Bundle.EMPTY), args);
        });
    }

    /**
     * Re-serialise the JS QueueItem[] (durations in seconds) to the native JSON
     * the service parses (durations in ms). Returns null on a malformed payload.
     */
    private String buildItemsJson(JSArray itemsArr) {
        try {
            JSONArray out = new JSONArray();
            // JSArray extends JSONArray; iterate via the JSONArray surface so we
            // don't depend on toList()'s element shape across Capacitor versions.
            for (int i = 0; i < itemsArr.length(); i++) {
                JSONObject in = itemsArr.optJSONObject(i);
                if (in == null) {
                    continue;
                }
                JSONObject o = new JSONObject();
                o.put("itemId", in.optString("itemId", ""));
                o.put("url", in.optString("url", ""));
                o.put("title", in.optString("title", ""));
                o.put("author", in.optString("author", ""));
                if (in.has("cover") && !in.isNull("cover")) {
                    o.put("cover", in.optString("cover", ""));
                }
                if (in.has("duration") && !in.isNull("duration")) {
                    double durationSec = in.optDouble("duration", 0);
                    o.put("durationMs", (long) (durationSec * 1000.0));
                }
                out.put(o);
            }
            return out.toString();
        } catch (JSONException e) {
            e.printStackTrace();
            return null;
        }
    }

    /** Convert a native QueueTransition list (ms) to the JS-facing JSArray (s). */
    private JSArray eventsToJsArray(List<QueueTransition> events) {
        JSArray arr = new JSArray();
        for (QueueTransition t : events) {
            arr.put(transitionToJs(t));
        }
        return arr;
    }

    private JSObject transitionToJs(QueueTransition t) {
        JSObject o = new JSObject();
        o.put("finishedItemId", t.finishedItemId == null ? "" : t.finishedItemId);
        o.put("fromPosition", Math.max(0, t.fromPositionMs) / 1000.0);
        o.put("finishedAt", Math.max(0, t.finishedAtMs) / 1000.0);
        o.put("duration", Math.max(0, t.durationMs) / 1000.0);
        if (t.startedItemId == null) {
            o.put("startedItemId", JSObject.NULL);
        } else {
            o.put("startedItemId", t.startedItemId);
        }
        o.put("reason", t.reason);
        o.put("at", t.atEpochMs);
        o.put("seq", t.seq);
        return o;
    }

    /** Best-effort foreground push of the newest journal entry to JS. */
    private void pushLatestTransition() {
        if (transitionCall == null || journal == null) {
            return;
        }
        List<QueueTransition> events = journal.readEvents();
        if (events.isEmpty()) {
            return;
        }
        QueueTransition latest = events.get(events.size() - 1);
        transitionCall.resolve(transitionToJs(latest));
    }

    /**
     * Build a MediaItem carrying the bookkeeping itemId in {@code mediaId} and
     * title/author in {@link MediaMetadata} so Media3 labels the lock-screen
     * notification per item without calling back into JS.
     *
     * <p>Artwork: when the track carries a remote {@code cover} URL it is set as
     * the artwork URI — Media3's DataSourceBitmapLoader fetches http(s)/content
     * URIs for the notification large icon. We never pass a local {@code file://}
     * URI here, as it can silently fail to load in the notification. When no
     * cover is available we fall back to a bundled branded bitmap via
     * {@code setArtworkData} (the reliable path for local art) so the
     * notification still shows app art instead of a blank large icon.
     */
    static MediaItem buildMediaItem(
            android.content.Context context,
            String itemId, String url, String title, String author,
            String cover, long durationMs) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(author);
        if (durationMs != C.TIME_UNSET && durationMs > 0) {
            meta.setDurationMs(durationMs);
        }
        boolean hasRemoteCover = cover != null && (cover.startsWith("http://")
                || cover.startsWith("https://") || cover.startsWith("content://"));
        if (hasRemoteCover) {
            meta.setArtworkUri(android.net.Uri.parse(cover));
        } else {
            byte[] artwork = bundledArtwork(context);
            if (artwork != null) {
                meta.setArtworkData(artwork, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
            }
        }
        return new MediaItem.Builder()
                .setUri(url)
                .setMediaId(itemId == null ? "" : itemId)
                .setMediaMetadata(meta.build())
                .build();
    }

    private static volatile byte[] cachedArtwork;

    /** Lazily decode + cache the bundled notification artwork as PNG bytes. */
    private static byte[] bundledArtwork(android.content.Context context) {
        if (cachedArtwork != null || context == null) {
            return cachedArtwork;
        }
        try {
            android.graphics.Bitmap bitmap = android.graphics.BitmapFactory.decodeResource(
                    context.getResources(), R.drawable.audio_player_artwork);
            if (bitmap == null) {
                return null;
            }
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
            cachedArtwork = out.toByteArray();
        } catch (Exception e) {
            e.printStackTrace();
        }
        return cachedArtwork;
    }
}
