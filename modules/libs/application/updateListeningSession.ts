import type {
  ListeningSessionId,
  TrackPositionSec,
} from "@lib/domain/listeningSession.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"

export interface UpdateListeningSessionInput {
  readonly id: ListeningSessionId
  readonly position: TrackPositionSec
  /** `true` to mark the update as the closing one (semantic only). */
  readonly final: boolean
}

export interface UpdateListeningSessionDeps {
  readonly listeningSessions: IListeningSessionRepository
}

export async function updateListeningSession(
  input: UpdateListeningSessionInput,
  deps: UpdateListeningSessionDeps
): Promise<void> {
  if (input.final) {
    await deps.listeningSessions.finish(input.id, { position: input.position })
  } else {
    await deps.listeningSessions.tick(input.id, { position: input.position })
  }
}
