import type { IOutboxRepository } from "@lib/domain/ports/outboxRepository.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { ISyncBackfillRepository } from "@lib/domain/ports/syncBackfillRepository.js"
import type { ISyncStateRepository } from "@lib/domain/ports/syncStateRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"

/**
 * The device-local key-value store the sync engine keeps its markers in. The
 * keys live on installed devices, so each one keeps its name and meaning.
 */
export interface ISyncMarkerStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * The engine repositories. Each sync repository is absent on a build that
 * does not journal; the getter that hands them out throws until the user
 * database is open.
 */
export interface SyncEngineRepositories {
  readonly syncOutbox?: IOutboxRepository
  readonly syncState?: ISyncStateRepository
  readonly syncApply?: ISyncApplyRepository
  readonly syncBackfill?: ISyncBackfillRepository
  readonly unitOfWork: IUnitOfWork
}
