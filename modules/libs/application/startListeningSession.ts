import type { PlaylistItemId } from "@lib/domain/core.js"
import type {
  ListeningSessionId,
  TrackPositionSec,
} from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export interface StartListeningSessionInput {
  readonly itemId: PlaylistItemId
  readonly position: TrackPositionSec
  /**
   * `false` (default): continue from the previous session's `to_position`,
   * so background play between two foreground sessions is captured.
   * `true`: explicitly start at `position` (used when the player just
   * seeked — the seek is a discontinuity, not continued listening).
   */
  readonly forceStart?: boolean
}

export interface StartListeningSessionDeps {
  readonly listeningSessions: IListeningSessionRepository
}

export async function startListeningSession(
  input: StartListeningSessionInput,
  deps: StartListeningSessionDeps
): Promise<ListeningSessionId> {
  if (input.forceStart) {
    return deps.listeningSessions.forceStart({ itemId: input.itemId, position: input.position })
  }
  return deps.listeningSessions.start({ itemId: input.itemId, position: input.position })
}
