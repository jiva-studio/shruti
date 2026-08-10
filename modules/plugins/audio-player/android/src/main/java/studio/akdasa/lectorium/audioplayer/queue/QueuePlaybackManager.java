package studio.jiva.shruti.audioplayer.queue;

import android.os.Handler;
import android.os.Looper;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;

/**
 * Owns the native auto-advance bookkeeping for the queue. Lives in the service
 * (the component that keeps running while the WebView JS is suspended) and
 * attaches a {@link Player.Listener} to the {@link ExoPlayer}.
 *
 * <p>On every item transition it appends a {@link QueueTransition} to the
 * durable {@link QueueJournal} <em>before</em> anything else, and it persists the
 * in-flight {@code {currentItemId, positionMs}} snapshot on key events plus a
 * coarse interval while playing — so state survives the process being killed in
 * the background.
 *
 * <p>Error policy: ExoPlayer does NOT auto-skip a failed queue item (it stops
 * and goes IDLE). On {@code onPlayerError} we journal the failed item with
 * {@code reason="error"} then {@code seekToNextMediaItem() + prepare()} to keep
 * the queue going, with a bounded retry budget so a run of bad items can't loop.
 *
 * <p>All callbacks run on the player's application looper (main).
 */
@OptIn(markerClass = UnstableApi.class)
public final class QueuePlaybackManager {

    private static final long SNAPSHOT_INTERVAL_MS = 30_000L;
    /** Consecutive item errors tolerated before we give up advancing, so a run
     *  of corrupt downloads can't spin the queue forever. */
    private static final int MAX_CONSECUTIVE_ERRORS = 5;

    private final ExoPlayer player;
    private final QueueJournal journal;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Where listening on the currently-playing item began (resume pt / 0). */
    private long currentFromPositionMs = 0;
    /** When it began, in wall-clock — same bookkeeping, same places. */
    private long currentFromAtEpochMs = System.currentTimeMillis();
    /** True for the transition that an error-recovery seek will produce, so we
     *  don't double-journal (the error path already wrote the transition). */
    private boolean suppressNextDiscontinuity = false;
    /** Pending explicit skip direction set by skipToNext/Previous; consumed by
     *  the resulting discontinuity to label it skip-next / skip-prev. */
    private String pendingSkipReason = null;
    private int consecutiveErrors = 0;

    private final Runnable snapshotTick = new Runnable() {
        @Override
        public void run() {
            if (player.isPlaying()) {
                persistSnapshot();
            }
            handler.postDelayed(this, SNAPSHOT_INTERVAL_MS);
        }
    };

    public QueuePlaybackManager(ExoPlayer player, QueueJournal journal) {
        this.player = player;
        this.journal = journal;
        player.addListener(new Listener());
        handler.postDelayed(snapshotTick, SNAPSHOT_INTERVAL_MS);
    }

    /** Called by the service when a fresh queue is set, to seed the from-position
     *  of the start item (only the start item honours a resume position). */
    public void onQueueStarted(long startPositionMs) {
        currentFromPositionMs = startPositionMs;
        currentFromAtEpochMs = System.currentTimeMillis();
        consecutiveErrors = 0;
        pendingSkipReason = null;
        suppressNextDiscontinuity = false;
        persistSnapshot();
    }

    /** Flag the next discontinuity as an explicit skip so it is journaled with
     *  the right reason instead of "auto". Call immediately before seeking. */
    public void markSkip(boolean next) {
        pendingSkipReason = next ? QueueTransition.REASON_SKIP_NEXT
                : QueueTransition.REASON_SKIP_PREV;
    }

    public void release() {
        handler.removeCallbacks(snapshotTick);
        persistSnapshot();
    }

    private void persistSnapshot() {
        MediaItem current = player.getCurrentMediaItem();
        String itemId = current != null ? current.mediaId : null;
        long pos = Math.max(0, player.getCurrentPosition());
        journal.persistSnapshot(itemId, pos);
    }

    private static String mediaIdAt(Player player, int index) {
        if (index == C.INDEX_UNSET) return null;
        if (index < 0 || index >= player.getMediaItemCount()) return null;
        MediaItem item = player.getMediaItemAt(index);
        return item != null ? item.mediaId : null;
    }

    private final class Listener implements Player.Listener {

        @Override
        public void onPositionDiscontinuity(
                Player.PositionInfo oldPosition,
                Player.PositionInfo newPosition,
                int reason) {
            // Seeks WITHIN the same item (e.g. ±15s, scrubbing) are not queue
            // transitions — only a change of media item is.
            if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex) {
                persistSnapshot();
                return;
            }

            if (suppressNextDiscontinuity) {
                // The error path already journaled this finished item.
                suppressNextDiscontinuity = false;
                currentFromPositionMs = Math.max(0, newPosition.positionMs);
                currentFromAtEpochMs = System.currentTimeMillis();
                consecutiveErrors = 0;
                persistSnapshot();
                return;
            }

            // Media3's PositionInfo exposes the MediaItem, not its id directly.
            String finishedItemId = oldPosition.mediaItem != null ? oldPosition.mediaItem.mediaId : "";
            String startedItemId = newPosition.mediaItem != null ? newPosition.mediaItem.mediaId : null;
            long finishedAtMs = Math.max(0, oldPosition.positionMs);
            long durationMs = durationOf(oldPosition.mediaItemIndex);

            String transitionReason;
            if (pendingSkipReason != null) {
                transitionReason = pendingSkipReason;
                pendingSkipReason = null;
            } else if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION) {
                transitionReason = QueueTransition.REASON_AUTO;
            } else {
                // An unattributed SEEK across items (e.g. a lock-screen
                // next/prev that bypassed markSkip). Treat by direction.
                transitionReason = newPosition.mediaItemIndex > oldPosition.mediaItemIndex
                        ? QueueTransition.REASON_SKIP_NEXT
                        : QueueTransition.REASON_SKIP_PREV;
            }

            journal.appendTransition(new QueueTransition(
                    finishedItemId,
                    currentFromPositionMs,
                    finishedAtMs,
                    durationMs,
                    startedItemId,
                    transitionReason,
                    System.currentTimeMillis(),
                    currentFromAtEpochMs,
                    0));

            // The started item begins at wherever the player landed (0 for an
            // auto-advance; only the original start item carried a resume pt).
            currentFromPositionMs = Math.max(0, newPosition.positionMs);
            currentFromAtEpochMs = System.currentTimeMillis();
            consecutiveErrors = 0;
            persistSnapshot();
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            if (playbackState == Player.STATE_ENDED) {
                // The last item finished naturally — no discontinuity to a next
                // item fires, so journal the dry-out here BEFORE the service
                // tears the foreground notification down.
                MediaItem current = player.getCurrentMediaItem();
                if (current == null) {
                    return;
                }
                long durationMs = player.getDuration();
                if (durationMs == C.TIME_UNSET) durationMs = 0;
                long finishedAtMs = Math.max(0, player.getCurrentPosition());
                journal.appendTransition(new QueueTransition(
                        current.mediaId,
                        currentFromPositionMs,
                        finishedAtMs,
                        durationMs,
                        null,
                        QueueTransition.REASON_AUTO,
                        System.currentTimeMillis(),
                        currentFromAtEpochMs,
                        0));
                journal.persistSnapshot(null, 0);
            }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            // ExoPlayer stopped on a failed item. Journal it as a partial
            // (reason="error"), then advance to keep the background queue alive.
            MediaItem current = player.getCurrentMediaItem();
            int currentIndex = player.getCurrentMediaItemIndex();
            boolean hasNext = currentIndex != C.INDEX_UNSET
                    && currentIndex + 1 < player.getMediaItemCount();
            String startedItemId = hasNext ? mediaIdAt(player, currentIndex + 1) : null;

            long durationMs = player.getDuration();
            if (durationMs == C.TIME_UNSET) durationMs = 0;
            long finishedAtMs = Math.max(0, player.getCurrentPosition());

            journal.appendTransition(new QueueTransition(
                    current != null ? current.mediaId : "",
                    currentFromPositionMs,
                    finishedAtMs,
                    durationMs,
                    startedItemId,
                    QueueTransition.REASON_ERROR,
                    System.currentTimeMillis(),
                    currentFromAtEpochMs,
                    0));

            consecutiveErrors++;
            if (hasNext && consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
                // The recovery seek produces a SEEK discontinuity we must not
                // re-journal — we already wrote the error transition above.
                suppressNextDiscontinuity = true;
                player.seekToNextMediaItem();
                player.prepare();
                currentFromPositionMs = 0;
                currentFromAtEpochMs = System.currentTimeMillis();
            } else {
                // Queue dry or too many failures: stop and clear the snapshot.
                journal.persistSnapshot(null, 0);
            }
        }

        @Override
        public void onMediaItemTransition(MediaItem mediaItem, int reason) {
            // Position bookkeeping is driven by onPositionDiscontinuity (which
            // carries the finished item's end position); this hook just keeps the
            // persisted snapshot fresh on the new item.
            persistSnapshot();
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            // Snapshot on pause (and on resume) so a background kill while
            // paused keeps an accurate resume position.
            persistSnapshot();
        }
    }

    private long durationOf(int mediaItemIndex) {
        // The finished item's duration: prefer the timeline window duration,
        // fall back to the MediaMetadata duration stashed at enqueue time.
        if (mediaItemIndex != C.INDEX_UNSET
                && mediaItemIndex >= 0
                && mediaItemIndex < player.getMediaItemCount()) {
            MediaItem item = player.getMediaItemAt(mediaItemIndex);
            if (item != null
                    && item.mediaMetadata != null
                    && item.mediaMetadata.durationMs != null) {
                return item.mediaMetadata.durationMs;
            }
        }
        // As a last resort use the player's reported duration (valid when the
        // finished item is still the current window, e.g. dry-out).
        long d = player.getDuration();
        return d == C.TIME_UNSET ? 0 : d;
    }
}
