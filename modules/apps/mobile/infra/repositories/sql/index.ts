import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import { createSqlNoteRepository } from "./notesRepository.sql.js"
import { createSqlPlaylistItemRepository } from "./playlistItemsRepository.sql.js"
import { createSqlListeningSessionRepository } from "./listeningSessionsRepository.sql.js"
import { createSqlMediaItemRepository } from "./mediaItemsRepository.sql.js"
import { createSqlUnitOfWork } from "./unitOfWork.sql.js"
import { createSqlTrackRepository } from "./tracksRepository.sql.js"
import { createSqlAuthorRepository } from "./authorsRepository.sql.js"
import { createSqlLocationRepository } from "./locationsRepository.sql.js"
import { createSqlSourceRepository } from "./sourcesRepository.sql.js"
import { createSqlLanguageRepository } from "./languagesRepository.sql.js"
import { createSqlTagRepository } from "./tagsRepository.sql.js"
import { createSqlChatSessionRepository } from "./chatSessionsRepository.sql.js"
import { createSqlChatMessageRepository } from "./chatMessagesRepository.sql.js"
import { createSqlProactiveStateRepository } from "./proactiveStateRepository.sql.js"
import { createSqlPackRepository } from "./packsRepository.sql.js"

export { createSqlSchemeVersionRepository } from "./schemeVersionRepository.sql.js"
export { createSqlNoteRepository } from "./notesRepository.sql.js"
export { createSqlPlaylistItemRepository } from "./playlistItemsRepository.sql.js"
export { createSqlListeningSessionRepository } from "./listeningSessionsRepository.sql.js"
export { createSqlMediaItemRepository } from "./mediaItemsRepository.sql.js"
export { createSqlUnitOfWork } from "./unitOfWork.sql.js"
export { createSqlTrackRepository } from "./tracksRepository.sql.js"
export { createSqlAuthorRepository } from "./authorsRepository.sql.js"
export { createSqlLocationRepository } from "./locationsRepository.sql.js"
export { createSqlSourceRepository } from "./sourcesRepository.sql.js"
export { createSqlLanguageRepository } from "./languagesRepository.sql.js"
export { createSqlTagRepository } from "./tagsRepository.sql.js"
export { createSqlChatSessionRepository } from "./chatSessionsRepository.sql.js"
export { createSqlChatMessageRepository } from "./chatMessagesRepository.sql.js"
export { createSqlProactiveStateRepository } from "./proactiveStateRepository.sql.js"
export { createSqlPackRepository } from "./packsRepository.sql.js"
export type { FeaturedPackRow, ISqlPackRepository } from "./packsRepository.sql.js"

export interface SqlAppRepositories {
  readonly tracks: ReturnType<typeof createSqlTrackRepository>
  readonly authors: ReturnType<typeof createSqlAuthorRepository>
  readonly locations: ReturnType<typeof createSqlLocationRepository>
  readonly sources: ReturnType<typeof createSqlSourceRepository>
  readonly languages: ReturnType<typeof createSqlLanguageRepository>
  readonly tags: ReturnType<typeof createSqlTagRepository>
  readonly notes: ReturnType<typeof createSqlNoteRepository>
  readonly playlistItems: ReturnType<typeof createSqlPlaylistItemRepository>
  readonly listeningSessions: ReturnType<typeof createSqlListeningSessionRepository>
  readonly mediaItems: ReturnType<typeof createSqlMediaItemRepository>
  readonly unitOfWork: ReturnType<typeof createSqlUnitOfWork>
  readonly chatSessions: ReturnType<typeof createSqlChatSessionRepository>
  readonly chatMessages: ReturnType<typeof createSqlChatMessageRepository>
  readonly proactiveState: ReturnType<typeof createSqlProactiveStateRepository>
  readonly packs: ReturnType<typeof createSqlPackRepository>
}

export interface CreateSqlAppRepositoriesDeps {
  readonly contentDb: IDatabase
  readonly userDb: IDatabase
  /**
   * Read on every query that depends on the active UI language (e.g. the
   * tracks repo's by-reference sort joins to track_variants for this code).
   */
  readonly getActiveLanguage: () => LanguageCode
}

/**
 * Bundles every SQL-backed domain repository on top of the two open
 * databases. Scoped to *SQL* adapters only — HTTP-backed repos (like
 * transcripts) are wired in the composition root (`lectorium/`),
 * because a sibling-infra import would violate the layer rules.
 */
export function createSqlAppRepositories(deps: CreateSqlAppRepositoriesDeps): SqlAppRepositories {
  return {
    tracks: createSqlTrackRepository({
      contentDb: deps.contentDb,
      getActiveLanguage: deps.getActiveLanguage,
    }),
    authors: createSqlAuthorRepository(deps.contentDb),
    locations: createSqlLocationRepository(deps.contentDb),
    sources: createSqlSourceRepository(deps.contentDb),
    languages: createSqlLanguageRepository(deps.contentDb),
    tags: createSqlTagRepository(deps.contentDb),
    notes: createSqlNoteRepository(deps.userDb),
    playlistItems: createSqlPlaylistItemRepository(deps.userDb),
    listeningSessions: createSqlListeningSessionRepository(deps.userDb),
    mediaItems: createSqlMediaItemRepository(deps.userDb),
    unitOfWork: createSqlUnitOfWork(deps.userDb),
    chatSessions: createSqlChatSessionRepository(deps.userDb),
    chatMessages: createSqlChatMessageRepository(deps.userDb),
    proactiveState: createSqlProactiveStateRepository(deps.userDb),
    packs: createSqlPackRepository(deps.contentDb),
  }
}
