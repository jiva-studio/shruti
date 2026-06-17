import type { PlaylistItemId } from "@lib/domain/core.js"
import type { TrackPositionSec } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export interface GetProgressForItemDeps {
  readonly listeningSessions: IListeningSessionRepository
}

/**
 * Resume position for an item, in seconds — the *high-water mark* (furthest
 * `to_position` ever reached), not the latest session's end, so rewinding
 * and stopping doesn't drop the user back to the rewound spot. `null` if the
 * item was never listened to (no sessions). Caller decides what to do with
 * `null` — usually it means "start from 0". The caller also clamps against
 * duration, so a finished track's high-water mark still restarts from 0.
 */
export async function getProgressForItem(
  itemId: PlaylistItemId,
  deps: GetProgressForItemDeps
): Promise<TrackPositionSec | null> {
  return deps.listeningSessions.getResumePositionForItem(itemId)
}
