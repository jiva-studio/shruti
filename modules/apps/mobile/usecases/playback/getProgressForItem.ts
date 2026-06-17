import type { PlaylistItemId } from "@lib/domain/core.js"
import type { TrackPositionSec } from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export interface GetProgressForItemDeps {
  readonly listeningSessions: IListeningSessionRepository
}

/**
 * Resume position for an item, in seconds. `null` if the item was never
 * listened to (no sessions). Caller decides what to do with `null` —
 * usually it means "start from 0".
 */
export async function getProgressForItem(
  itemId: PlaylistItemId,
  deps: GetProgressForItemDeps
): Promise<TrackPositionSec | null> {
  const session = await deps.listeningSessions.getLastSessionForItem(itemId)
  return session?.toPosition ?? null
}
