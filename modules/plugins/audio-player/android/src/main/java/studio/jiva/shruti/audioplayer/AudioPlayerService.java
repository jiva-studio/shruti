package studio.jiva.shruti.audioplayer;

import android.content.Context;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;

import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import studio.jiva.shruti.audioplayer.audioprocessor.StereoMixAudioProcessor;

/**
 * Media3 {@link MediaSessionService} that owns the {@link ExoPlayer} and a
 * {@link MediaSession}. Media3 builds and keeps the media-style notification in
 * sync with the current MediaItem's MediaMetadata for us, so the old 500ms
 * hand-built notification loop is gone.
 *
 * <p>Hard constraint preserved across the migration: the player is built with a
 * custom {@link DefaultRenderersFactory} that injects {@link StereoMixAudioProcessor}
 * into the audio sink, so the stereo→mono blend keeps working. The same player
 * instance is handed to the session, so mix + playback rate live on the player
 * and survive item transitions for free.
 */
@OptIn(markerClass = UnstableApi.class)
public final class AudioPlayerService extends MediaSessionService {

    /** ±15s custom lock-screen / notification actions, kept from the legacy
     *  MediaSessionCompat implementation. */
    public static final String ACTION_REWIND_15 = "studio.jiva.shruti.audioplayer.REWIND_15";
    public static final String ACTION_FORWARD_15 = "studio.jiva.shruti.audioplayer.FORWARD_15";
    /** Controller→service command carrying the stereo-mix slider state, which
     *  cannot travel over the standard Player interface a MediaController
     *  exposes. Args: {@code enabled:boolean, ratio:float}. */
    public static final String ACTION_SET_MIX = "studio.jiva.shruti.audioplayer.SET_MIX";
    /** Replace the queue. Args: {@code items:String} (JSON array of
     *  {itemId,url,title,author,duration?}), {@code startIndex:int},
     *  {@code startPositionMs:long}. */
    public static final String ACTION_SET_QUEUE = "studio.jiva.shruti.audioplayer.SET_QUEUE";
    /** Append to the queue tail. Args: {@code items:String} (JSON array). */
    public static final String ACTION_APPEND_QUEUE = "studio.jiva.shruti.audioplayer.APPEND_QUEUE";
    /** Skip with journaling intent. Args: {@code next:boolean}. */
    public static final String ACTION_SKIP = "studio.jiva.shruti.audioplayer.SKIP";

    private static final long SEEK_STEP_MS = 15_000L;

    private ExoPlayer exoPlayer;
    private MediaSession mediaSession;
    private final StereoMixAudioProcessor stereoMixProcessor = new StereoMixAudioProcessor();
    private studio.jiva.shruti.audioplayer.queue.QueueJournal journal;
    private studio.jiva.shruti.audioplayer.queue.QueuePlaybackManager queueManager;

    @Override
    public void onCreate() {
        super.onCreate();
        Context context = getApplicationContext();

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(context) {
            @Override
            protected AudioSink buildAudioSink(
                    Context context,
                    boolean enableFloatOutput,
                    boolean enableAudioTrackPlaybackParams) {
                // Same defaults as DefaultRenderersFactory.buildAudioSink, plus
                // our stereo→mono blender. Audio offload is implicitly off
                // because supplying a non-default processor chain forces the
                // sink to a software path; that's what we want — offload
                // would route around our processor entirely.
                return new DefaultAudioSink.Builder(context)
                        .setEnableFloatOutput(enableFloatOutput)
                        .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                        .setAudioProcessors(new AudioProcessor[]{stereoMixProcessor})
                        .build();
            }
        };

        // Speech-media audio attributes with ExoPlayer managing audio focus, so
        // playback pauses/ducks for a phone call or another app and resumes
        // after, instead of talking over them. `handleAudioBecomingNoisy` pauses
        // when headphones are unplugged rather than blasting the speaker.
        // (Default Builder is handleAudioFocus=false — the gap on Android; iOS
        // already handles interruptions in AudioPlayerPlugin.swift.)
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                .build();
        exoPlayer = new ExoPlayer.Builder(context, renderersFactory)
                .setAudioAttributes(audioAttributes, /* handleAudioFocus= */ true)
                .setHandleAudioBecomingNoisy(true)
                .build();
        // Battery optimization can force-close even a foreground media service
        // mid-queue; a local wake lock keeps long offline playback alive. Items
        // played over HTTP would want WAKE_MODE_NETWORK, but our queue is
        // local-file first, so local is the right default.
        exoPlayer.setWakeMode(C.WAKE_MODE_LOCAL);

        // Native auto-advance bookkeeping + durable journal. Must be attached
        // before any playback so no transition is missed.
        journal = new studio.jiva.shruti.audioplayer.queue.QueueJournal(context);
        queueManager = new studio.jiva.shruti.audioplayer.queue.QueuePlaybackManager(
                exoPlayer, journal);

        mediaSession = new MediaSession.Builder(this, exoPlayer)
                .setCallback(new SessionCallback())
                .setCustomLayout(buildCustomLayout())
                .build();

        // Media3's default notification small icon is a generic media glyph.
        // The status-bar small icon is a monochrome alpha mask, so the
        // full-colour launcher icon can't be used here — it would render as a
        // featureless white blob. Supply a dedicated white-on-transparent
        // drawable instead.
        DefaultMediaNotificationProvider notificationProvider =
                new DefaultMediaNotificationProvider.Builder(this).build();
        notificationProvider.setSmallIcon(R.drawable.ic_stat_player);
        setMediaNotificationProvider(notificationProvider);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onDestroy() {
        if (queueManager != null) {
            queueManager.release();
            queueManager = null;
        }
        if (mediaSession != null) {
            mediaSession.getPlayer().release();
            mediaSession.release();
            mediaSession = null;
        }
        exoPlayer = null;
        super.onDestroy();
    }

    /* -------------------------------------------------------------------------- */
    /*                          Stereo-mix custom commands                        */
    /* -------------------------------------------------------------------------- */

    private ImmutableList<CommandButton> buildCustomLayout() {
        CommandButton rewind = new CommandButton.Builder()
                .setDisplayName("-15s")
                .setIconResId(android.R.drawable.ic_media_rew)
                .setSessionCommand(new SessionCommand(ACTION_REWIND_15, Bundle.EMPTY))
                .build();
        CommandButton forward = new CommandButton.Builder()
                .setDisplayName("+15s")
                .setIconResId(android.R.drawable.ic_media_ff)
                .setSessionCommand(new SessionCommand(ACTION_FORWARD_15, Bundle.EMPTY))
                .build();
        return ImmutableList.of(rewind, forward);
    }

    /* -------------------------------------------------------------------------- */
    /*                              Queue operations                              */
    /* -------------------------------------------------------------------------- */

    private void setQueue(String itemsJson, int startIndex, long startPositionMs) {
        if (exoPlayer == null) return;
        java.util.List<MediaItem> items = parseItems(itemsJson);
        if (items.isEmpty()) return;
        int idx = Math.max(0, Math.min(startIndex, items.size() - 1));
        exoPlayer.stop();
        exoPlayer.setMediaItems(items, idx, startPositionMs);
        if (queueManager != null) {
            queueManager.onQueueStarted(startPositionMs);
        }
        exoPlayer.prepare();
        exoPlayer.play();
    }

    private void appendQueue(String itemsJson) {
        if (exoPlayer == null) return;
        java.util.List<MediaItem> items = parseItems(itemsJson);
        if (items.isEmpty()) return;
        exoPlayer.addMediaItems(items);
        // If the queue had already run dry (IDLE/ENDED) the appended items need
        // a fresh prepare to start playing.
        if (exoPlayer.getPlaybackState() == androidx.media3.common.Player.STATE_ENDED
                || exoPlayer.getPlaybackState() == androidx.media3.common.Player.STATE_IDLE) {
            exoPlayer.prepare();
        }
    }

    private void skip(boolean next) {
        if (exoPlayer == null) return;
        // Only mark + seek when there is actually a target item, otherwise a
        // dangling skip flag would mislabel the next genuine transition.
        boolean canSkip = next
                ? exoPlayer.hasNextMediaItem()
                : exoPlayer.hasPreviousMediaItem();
        if (!canSkip) return;
        if (queueManager != null) {
            // Tag the upcoming discontinuity so it's journaled as a skip, not auto.
            queueManager.markSkip(next);
        }
        if (next) {
            exoPlayer.seekToNextMediaItem();
        } else {
            exoPlayer.seekToPreviousMediaItem();
        }
    }

    private java.util.List<MediaItem> parseItems(String itemsJson) {
        java.util.List<MediaItem> out = new java.util.ArrayList<>();
        try {
            org.json.JSONArray arr = new org.json.JSONArray(itemsJson);
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String url = o.optString("url", null);
                if (url == null || url.isEmpty()) continue;
                String itemId = o.optString("itemId", "");
                String title = o.optString("title", "");
                String author = o.optString("author", "");
                String cover = o.optString("cover", null);
                long durationMs = o.has("durationMs") ? o.optLong("durationMs", C.TIME_UNSET)
                        : C.TIME_UNSET;
                out.add(AudioPlayerPlugin.buildMediaItem(
                        this, itemId, url, title, author, cover, durationMs));
            }
        } catch (org.json.JSONException e) {
            e.printStackTrace();
        }
        return out;
    }

    private void seekBy(long deltaMs) {
        if (exoPlayer == null) return;
        long current = exoPlayer.getCurrentPosition();
        long duration = exoPlayer.getDuration();
        long target = current + deltaMs;
        if (target < 0) target = 0;
        if (duration != C.TIME_UNSET && target > duration) target = duration;
        exoPlayer.seekTo(target);
    }

    /**
     * Session callback: advertises the ±15s custom commands to every connecting
     * controller and dispatches them onto the player. Play/pause/seek/next/prev
     * are standard Player commands handled by Media3 directly.
     */
    private final class SessionCallback implements MediaSession.Callback {
        @Override
        public MediaSession.ConnectionResult onConnect(
                MediaSession session, MediaSession.ControllerInfo controller) {
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(
                            MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                                    .add(new SessionCommand(ACTION_REWIND_15, Bundle.EMPTY))
                                    .add(new SessionCommand(ACTION_FORWARD_15, Bundle.EMPTY))
                                    .add(new SessionCommand(ACTION_SET_MIX, Bundle.EMPTY))
                                    .add(new SessionCommand(ACTION_SET_QUEUE, Bundle.EMPTY))
                                    .add(new SessionCommand(ACTION_APPEND_QUEUE, Bundle.EMPTY))
                                    .add(new SessionCommand(ACTION_SKIP, Bundle.EMPTY))
                                    .build())
                    .build();
        }

        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
                MediaSession session,
                MediaSession.ControllerInfo controller,
                SessionCommand customCommand,
                Bundle args) {
            if (ACTION_REWIND_15.equals(customCommand.customAction)) {
                seekBy(-SEEK_STEP_MS);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            } else if (ACTION_FORWARD_15.equals(customCommand.customAction)) {
                seekBy(SEEK_STEP_MS);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            } else if (ACTION_SET_MIX.equals(customCommand.customAction)) {
                boolean enabled = args.getBoolean("enabled", false);
                float ratio = args.getFloat("ratio", 0.5f);
                stereoMixProcessor.setMix(enabled, ratio);
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            } else if (ACTION_SET_QUEUE.equals(customCommand.customAction)) {
                setQueue(args.getString("items", "[]"),
                        args.getInt("startIndex", 0),
                        args.getLong("startPositionMs", 0));
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            } else if (ACTION_APPEND_QUEUE.equals(customCommand.customAction)) {
                appendQueue(args.getString("items", "[]"));
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            } else if (ACTION_SKIP.equals(customCommand.customAction)) {
                skip(args.getBoolean("next", true));
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
            }
            return Futures.immediateFuture(new SessionResult(SessionError.ERROR_NOT_SUPPORTED));
        }
    }
}
