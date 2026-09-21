import { computed, type ComputedRef, type Ref } from "vue"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { playbackErrorKey } from "@shruti/utils/playbackErrorKey.js"

export interface TranscriptPlaybackDeps {
  readonly getTrack: () => Track | null | undefined
  readonly activeLanguages: Ref<readonly LanguageCode[]>
  readonly authorEntity: Ref<Author | null | undefined>
  readonly onError: (key: string) => void
}

export interface TranscriptPlayback {
  /** True when the dialog mirrors the track the player holds — what makes a
   *  live position, and seeking, meaningful. */
  readonly mirrorsActivePlayer: ComputedRef<boolean>
  readonly position: ComputedRef<number>
  readonly duration: ComputedRef<number>
  onSeek: (positionMs: number) => void
  onChapterSeek: (positionMs: number) => Promise<void>
}

/** The open transcript's relationship to the player: whether it mirrors it,
 *  and the two ways the reader drives it. */
export function useTranscriptPlayback(deps: TranscriptPlaybackDeps): TranscriptPlayback {
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const transcriptStore = useTranscriptStore()

  const mirrorsActivePlayer = computed<boolean>(
    () => transcriptStore.trackId !== null && transcriptStore.trackId === player.trackId
  )

  // Preview mode (no track playing, or a different one): the global player
  // says nothing about the open transcript, so pin both to 0 and let each
  // paragraph render its own static `startTime`. Milliseconds throughout —
  // the same unit as `transcript.blocks[].start`.
  const position = computed(() => (mirrorsActivePlayer.value ? Math.max(0, player.positionMs) : 0))
  const duration = computed(() => (mirrorsActivePlayer.value ? Math.max(0, player.durationMs) : 0))

  function onSeek(positionMs: number): void {
    // Preview mode (transcript open without that track in the player):
    // seeking would jump the user's actual playback to a random place.
    if (!mirrorsActivePlayer.value) return
    void player.seek(Math.round(positionMs))
  }

  // Chapter tapped (outline row or inline heading). Unlike a plain seek this
  // is an explicit "take me here and play": jump + ensure playback. In
  // preview mode the track isn't loaded yet, so start it from the chapter.
  async function onChapterSeek(positionMs: number): Promise<void> {
    const ms = Math.max(0, Math.round(positionMs))
    if (mirrorsActivePlayer.value) {
      await player.seek(ms)
      if (!player.playing) await player.togglePause()
      return
    }
    const track = deps.getTrack()
    if (!track) return
    // Preview mode: load this track and start at the chapter. Pass the
    // playlist item id (resume/queue persistence) and the author entity
    // (system-player label), mirroring how the player is opened elsewhere.
    const result = await player.openTrack({
      track,
      preferredLanguage: deps.activeLanguages.value[0],
      author: deps.authorEntity.value,
      itemId: playlist.getEntryByTrackId(track.id)?.item.id,
      resumeFromMs: ms,
    })
    // Chapter rows render off the outline alone, with no audio gate, so a
    // transcript-only lecture reaches this with "no-audio-available" —
    // permanent, and told apart from the retryable engine failure.
    if (!result.ok) deps.onError(playbackErrorKey(result.error))
  }

  return { mirrorsActivePlayer, position, duration, onSeek, onChapterSeek }
}
