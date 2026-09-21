import type { Ref } from "vue"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"

/** The reactive identity of whatever the engine is playing right now. */
export interface PlayerIdentityRefs {
  readonly trackId: Ref<TrackId | null>
  readonly title: Ref<string>
  readonly authorName: Ref<string>
  readonly language: Ref<LanguageCode | null>
  readonly playing: Ref<boolean>
  readonly positionMs: Ref<number>
  readonly durationMs: Ref<number>
  readonly itemId: Ref<PlaylistItemId | null>
}

export interface TrackLabels {
  readonly title: string
  readonly authorName: string
}

/**
 * The labels to show for a queue item. Queue metadata wins — it is what the
 * lock screen already displays — but it carries `""` for a track with no
 * resolvable author, and an empty string has to fall through to the play plan
 * rather than blanking the player.
 */
export function pickTrackLabels(meta: AudioQueueItem | undefined, plan: TrackLabels): TrackLabels {
  return {
    title: meta?.title || plan.title,
    authorName: meta?.author || plan.authorName,
  }
}

/** The engine's own duration when it reports one, the play plan's otherwise. */
export function pickDurationMs(reportedMs: number, plannedMs?: number | null): number {
  return reportedMs > 0 ? reportedMs : (plannedMs ?? 0)
}
