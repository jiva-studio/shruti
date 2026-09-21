import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { playTrack } from "@usecases/playback/playTrack.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { AudioQueueState } from "@ports/app/audioPlayer.js"
import { useShruti } from "@shruti/shruti.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { pickDurationMs, pickTrackLabels, type PlayerIdentityRefs } from "./playerIdentity.js"
import { usePlayerQueueReconcile } from "./usePlayerQueueReconcile.js"
import type { PlayerQueueMirrorReturn } from "./usePlayerQueueMirror.js"
import type { PlayerSessionReturn } from "./usePlayerSession.js"

export interface PlayerNativeSyncDeps {
  readonly refs: PlayerIdentityRefs
  readonly queue: PlayerQueueMirrorReturn
  readonly session: PlayerSessionReturn
  /** Re-push mix + speed; a restored engine is back at its defaults. */
  readonly applyEngineSettings: () => void
}

export interface PlayerNativeSyncReturn {
  /**
   * Drain the native queue's transition journal into listening history, then
   * resync the player to whatever the engine is now playing. Runs on
   * foreground auto-advance, on app resume, and once at startup — the startup
   * drain is what recovers progress for a queue that played out (and possibly
   * got killed) entirely in the background.
   */
  syncFromNative(): Promise<void>
}

/**
 * Follows the native engine: what it is playing, what it finished while JS was
 * suspended, and what the player's reactive identity should therefore be.
 */
export function usePlayerNativeSync(deps: PlayerNativeSyncDeps): PlayerNativeSyncReturn {
  const app = useShruti()
  const reconcile = usePlayerQueueReconcile()
  const { t } = useI18n()
  const toast = useToast()
  const { refs, queue, session } = deps

  // Single-flight guard: init / resume / foreground-advance can all trigger a
  // drain near-simultaneously.
  let syncing = false

  /**
   * Close out the item we're moving off, the same handoff `openTrack` does.
   * Disarms the progress guard first so late events can't mutate state against
   * a stale identity.
   */
  async function handOffSession(nextId: PlaylistItemId | null): Promise<void> {
    const prevItemId = refs.itemId.value
    const prevPositionMs = refs.positionMs.value
    refs.itemId.value = null
    if (!prevItemId || prevItemId === nextId) return
    // Best-effort: a rejected finish must not abort the resync, or `itemId`
    // stays null and the player vanishes until the next successful resume.
    try {
      await session.finishCurrent(prevItemId, prevPositionMs)
    } catch (err) {
      console.warn("[player] finishCurrent during resync failed", err)
    }
  }

  /**
   * Move the player's identity onto a queue item the engine advanced to.
   *
   * When the item can't be named or planned — row hard-deleted, no playable
   * audio — the identity is let go rather than left pinned to the PREVIOUS
   * lecture: pinned, every later tick fails the identity guard and lands back
   * here while a pause tap patches the wrong item. The next transition onto a
   * playable item re-adopts.
   */
  async function resyncTo(
    id: PlaylistItemId,
    positionMsValue: number,
    durationMsValue: number,
    isPlaying: boolean
  ): Promise<void> {
    const track = await usePlaylistStore().resolveTrackForItemId(id)
    // Resolve the plan BEFORE mutating anything, so a half-adopted identity
    // (new `itemId`, old title/duration) can never be committed.
    const plan = track
      ? await playTrack({ track, preferredLanguage: refs.language.value ?? undefined, itemId: id })
      : null
    if (!plan?.ok) {
      await handOffSession(null)
      refs.playing.value = false
      return
    }
    const cmd = plan.value
    const transcript = useTranscriptStore()
    const wasMirroringTranscript =
      transcript.trackId !== null && transcript.trackId === refs.trackId.value

    await handOffSession(id)
    const labels = pickTrackLabels(queue.metaFor(id), cmd)
    refs.trackId.value = cmd.trackId
    refs.title.value = labels.title
    refs.authorName.value = labels.authorName
    refs.language.value = cmd.language
    refs.durationMs.value = pickDurationMs(durationMsValue, cmd.audio.duration)
    refs.positionMs.value = positionMsValue
    refs.playing.value = isPlaying
    refs.itemId.value = id

    deps.applyEngineSettings()

    // Continuous playback should carry an open, player-mirroring transcript to
    // the new lecture — otherwise it stops mirroring and the player vanishes
    // mid-queue.
    if (wasMirroringTranscript) transcript.show(cmd.trackId)
  }

  async function adoptCurrent(state: AudioQueueState, currentId: PlaylistItemId): Promise<void> {
    // A queue restored from a previous session that is paused and was never
    // resumed in THIS one is a phantom: adopting it surfaces the player with
    // nothing playing. A track the user paused after opening keeps `itemId`
    // set, so this never hides a legitimately-paused player.
    if (!state.playing && refs.itemId.value === null) return
    // A live native item is NOT by itself continuous playback — `open()` is
    // natively a queue of length one, and arming queue mode for it upgrades a
    // single-track open into the whole playlist tail. Only a genuinely
    // multi-item engine queue arms it; that still covers a cold restore, where
    // the engine reports what it really holds. Never disarmed: a queue handed
    // over legitimately can hold a single entry (the playlist's last lecture).
    if (state.queueCount > 1) queue.markActive()
    if (queue.isActive()) await queue.ensureMirror(currentId)
    if (currentId !== refs.itemId.value) {
      await resyncTo(currentId, state.positionMs, state.durationMs, state.playing)
    }
    // A deferred rewrite lands as soon as the engine is playing again —
    // including a lock-screen resume, which never reaches `togglePause`.
    if (queue.needsRewrite() && state.playing) await queue.push(state)
    await queue.flushEvictions()
  }

  /**
   * Nothing current natively and nothing playing. NOT gated on queue mode: the
   * single-track path never arms it, and a stuck `playing` wedges recovery,
   * since the re-tap short-circuit turns every tap on that row into a no-op.
   */
  async function goIdle(): Promise<void> {
    refs.playing.value = false
    queue.clear()
    queue.markEngineReplaced()
    await queue.flushEvictions(true)
  }

  async function syncFromNative(): Promise<void> {
    if (syncing) return
    syncing = true
    try {
      const s = await app.audioPlayer.getQueueState()
      await reconcile.reconcileAndAck(s.events)
      // A drained transition with reason "error" means the engine failed on an
      // item (404, unreadable file). Native auto-skips when there is a next
      // item; a single track just stops with nothing told to the user. Events
      // are ack'd above, so each error is seen exactly once, and the refusal
      // the `openTrack` call sites report is exclusive with this one: neither
      // `open` nor `setQueue` awaits readiness, so a bad URL can only arrive
      // here.
      if (s.events.some((e) => e.reason === "error")) {
        void toast.error(t("errors.playbackFailed"))
      }
      if (s.currentItemId) await adoptCurrent(s, s.currentItemId)
      else if (!s.playing) await goIdle()
    } catch (e) {
      // Best-effort — a drain failure must not break playback, but it signals a
      // native-queue desync worth knowing about.
      reportError("player", e)
    } finally {
      syncing = false
    }
  }

  return { syncFromNative }
}
