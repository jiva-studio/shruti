import type { Ref } from "vue"
import {
  playTrack,
  type PlayTrackCommand,
  type PlayTrackError,
} from "@usecases/playback/playTrack.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, PlaylistItemId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@kit/core"
import { useShruti } from "@shruti/shruti.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import type { PlayerIdentityRefs } from "./playerIdentity.js"
import { usePlayerEngineLoad } from "./usePlayerEngineLoad.js"
import { usePlayerResumePosition } from "./usePlayerResumePosition.js"
import type { PlayerQueueMirrorReturn } from "./usePlayerQueueMirror.js"
import type { PlayerSessionReturn } from "./usePlayerSession.js"

export interface OpenArgs {
  readonly track: Track
  readonly preferredLanguage?: LanguageCode
  /** Optional — used only for the system-player "author" label. */
  readonly author?: Author | null
  /** Required for progress persistence; without it position is not saved. */
  readonly itemId?: PlaylistItemId
  /** Milliseconds to resume at. Omitted = look it up; `0` = from the start. */
  readonly resumeFromMs?: number | null
}

export type OpenTrackResult = Result<void, PlayTrackError | "engine-failed">

export interface PlayerOpenTrackDeps {
  readonly refs: PlayerIdentityRefs
  readonly queue: PlayerQueueMirrorReturn
  readonly session: PlayerSessionReturn
  readonly autoPlayNext: Ref<boolean>
  readonly subscribeOnce: () => void
  /** Re-push mix + speed; a fresh native item loses both. */
  readonly applyEngineSettings: () => void
  readonly seek: (ms: number) => Promise<void>
}

export interface PlayerOpenTrackReturn {
  /**
   * Open a track for playback. Getting to the first sound costs a play plan, a
   * session hand-off, a resume lookup and possibly a whole download, so the row
   * is claimed synchronously up front and released on every exit path.
   */
  openTrack(args: OpenArgs): Promise<OpenTrackResult>
}

const DONE: OpenTrackResult = { ok: true, value: undefined }

export function usePlayerOpenTrack(deps: PlayerOpenTrackDeps): PlayerOpenTrackReturn {
  const app = useShruti()
  const autoOpenTranscript = useConfig<boolean>("settings.openTranscriptAutomatically", false)
  const resumePosition = usePlayerResumePosition()
  const engine = usePlayerEngineLoad(deps)
  const { refs, session } = deps

  // Each `loadTrack` bumps this and bails after any await once a newer call
  // has started — otherwise two concurrent opens interleave and the loser
  // commits its identity over the track the winner actually loaded.
  let openGeneration = 0

  function plannedDurationMs(cmd: PlayTrackCommand): number {
    return cmd.audio.duration ?? 0
  }

  function isSameItem(cmd: PlayTrackCommand): boolean {
    return (
      cmd.itemId === refs.itemId.value &&
      cmd.trackId === refs.trackId.value &&
      cmd.language === refs.language.value
    )
  }

  /**
   * Is `id` still loaded in the engine? Our identity says nothing about that:
   * on iOS the last item of a queue leaves the player alive with no current
   * item and `play()` a no-op. Only consulted to decide AGAINST the fast path.
   */
  async function engineHolds(id: PlaylistItemId): Promise<boolean> {
    const s = await app.audioPlayer.getQueueState().catch(() => null)
    return s === null || s.currentItemId === id
  }

  /**
   * Re-tap on the loaded track/variant: don't reload the audio, the engine
   * position would reset to 0. Resume if paused, and honour a position the
   * caller named — that is how a chapter tap moves the playhead.
   */
  async function resumeLoaded(
    cmd: PlayTrackCommand,
    args: OpenArgs,
    stale: () => boolean
  ): Promise<OpenTrackResult> {
    if (stale()) return DONE
    deps.subscribeOnce()
    if (args.resumeFromMs !== undefined) {
      const known = refs.durationMs.value > 0 ? refs.durationMs.value : plannedDurationMs(cmd)
      const target = await resumePosition.resolve(
        { itemId: args.itemId, resumeFromMs: args.resumeFromMs },
        known
      )
      if (stale()) return DONE
      await deps.seek(target)
    }
    if (!refs.playing.value) {
      try {
        await app.audioPlayer.play()
      } catch {
        return { ok: false, error: "engine-failed" }
      }
    }
    return DONE
  }

  /**
   * Close out the previous session BEFORE the engine is touched, so a fast
   * back-tap to the old row sees the latest position. The progress guard is
   * disarmed first, against late events from the previous track.
   */
  async function swapSession(): Promise<void> {
    const prevItemId = refs.itemId.value
    const prevPositionMs = refs.positionMs.value
    refs.itemId.value = null
    if (prevItemId) await session.finishCurrent(prevItemId, prevPositionMs)
  }

  // Over the storage budget this returns null and playback streams instead.
  async function resolveAudioUrl(cmd: PlayTrackCommand): Promise<string> {
    const localUrl = await useDownloadStore().ensureDownloaded(
      cmd.trackId,
      cmd.audio.path,
      cmd.audio.filesize
    )
    return localUrl ?? app.storagePublicUrl.get(cmd.audio.path)
  }

  function commitIdentity(cmd: PlayTrackCommand, resumeMs: number): void {
    refs.trackId.value = cmd.trackId
    refs.title.value = cmd.title
    refs.authorName.value = cmd.authorName
    refs.language.value = cmd.language
    refs.itemId.value = cmd.itemId
    refs.durationMs.value = plannedDurationMs(cmd)
    refs.positionMs.value = resumeMs
    if (autoOpenTranscript.value) useTranscriptStore().show(cmd.trackId)
  }

  async function loadTrack(args: OpenArgs): Promise<OpenTrackResult> {
    // Any open already in flight is now stale.
    const gen = ++openGeneration
    const stale = (): boolean => gen !== openGeneration

    const plan = await playTrack({
      track: args.track,
      preferredLanguage: args.preferredLanguage,
      author: args.author,
      itemId: args.itemId,
    })
    if (stale()) return DONE
    if (!plan.ok) return plan
    const cmd = plan.value

    if (isSameItem(cmd) && (await engineHolds(cmd.itemId))) {
      return resumeLoaded(cmd, args, stale)
    }

    await swapSession()
    if (stale()) return DONE

    const resumeMs = await resumePosition.resolve(
      { itemId: args.itemId, resumeFromMs: args.resumeFromMs },
      plannedDurationMs(cmd)
    )
    if (stale()) return DONE
    const url = await resolveAudioUrl(cmd)
    if (stale()) return DONE

    deps.subscribeOnce()
    if (!(await engine.start(cmd, url, resumeMs, args))) {
      return { ok: false, error: "engine-failed" }
    }
    // A newer open won the race while we loaded the engine: `cmd` no longer
    // reflects what is playing, so leave the identity to it.
    if (stale()) return DONE

    commitIdentity(cmd, resumeMs)
    return DONE
  }

  async function openTrack(args: OpenArgs): Promise<OpenTrackResult> {
    const downloads = useDownloadStore()
    downloads.markPending(args.track.id)
    try {
      return await loadTrack(args)
    } finally {
      downloads.clearPending(args.track.id)
    }
  }

  return { openTrack }
}
