import type { Result } from "@kit/core"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import { getProgressForItem } from "@usecases/playback/getProgressForItem.js"
import {
  loadTrackDetail,
  type LoadTrackDetailError,
  type TrackDetail,
} from "@usecases/playback/loadTrackDetail.js"
import {
  loadTranscript,
  type LoadedTranscript,
  type LoadTranscriptError,
  type LoadTranscriptInput,
} from "@usecases/playback/loadTranscript.js"
import {
  useListeningSessionTracker,
  type ListeningSessionTracker,
} from "@shruti/composables/useListeningSessionTracker.js"
import { useShruti } from "@shruti/shruti.js"

export interface PlaybackUseCases {
  /** The last saved position of a playlist item, in seconds, or `null`. */
  progressForItem(itemId: PlaylistItemId): Promise<number | null>
  /** A listening-session tracker writing to this device's history. */
  createSessionTracker(): ListeningSessionTracker
  loadTrackDetail(trackId: TrackId): Promise<Result<TrackDetail, LoadTrackDetailError>>
  loadTranscript(input: LoadTranscriptInput): Promise<Result<LoadedTranscript, LoadTranscriptError>>
}

/** The playback use cases, bound to the repositories, which are resolved per
 *  call and so throw until the databases are open. */
export function usePlaybackUseCases(): PlaybackUseCases {
  const app = useShruti()
  return {
    progressForItem: (itemId) =>
      getProgressForItem(itemId, { listeningSessions: app.repositories().listeningSessions }),
    createSessionTracker: () =>
      useListeningSessionTracker({ getRepo: () => app.repositories().listeningSessions }),
    loadTrackDetail: (trackId) => loadTrackDetail({ trackId }, app.repositories()),
    loadTranscript: (input) => loadTranscript(input, app.repositories()),
  }
}
