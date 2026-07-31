import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import { createSqlNoteRepository } from "./notesRepository.sql.js"
import { createSqlPlaylistItemRepository } from "./playlistItemsRepository.sql.js"
import { createSqlLibraryItemRepository } from "./libraryItemsRepository.sql.js"
import { createSqlLibraryMembershipRepository } from "./libraryMembershipsRepository.sql.js"
import { createSqlListeningSessionRepository } from "./listeningSessionsRepository.sql.js"
import { createSqlMediaItemRepository } from "./mediaItemsRepository.sql.js"
import { createSqlTrackRepository } from "./tracksRepository.sql.js"
import { createCompositeTrackRepository } from "./compositeTrackRepository.js"
import { createSqlAuthorRepository } from "./authorsRepository.sql.js"
import { createSqlLocationRepository } from "./locationsRepository.sql.js"
import { createSqlSourceRepository } from "./sourcesRepository.sql.js"
import { createSqlLanguageRepository } from "./languagesRepository.sql.js"
import { createSqlTagRepository } from "./tagsRepository.sql.js"
import { createSqlTopicRepository } from "./topicsRepository.sql.js"
import { createSqlChatSessionRepository } from "./chatSessionsRepository.sql.js"
import { createSqlChatMessageRepository } from "./chatMessagesRepository.sql.js"
import { createSqlProactiveStateRepository } from "./proactiveStateRepository.sql.js"
import { createSqlCollectionRepository } from "./collectionsRepository.sql.js"
import { createSqlSettingsRepository } from "./settingsRepository.sql.js"
import { createSqlDailyWisdomRepository } from "./dailyWisdomRepository.sql.js"
import { createReentrantUnitOfWork } from "./reentrantUnitOfWork.sql.js"
import { withSyncJournaling } from "./syncJournalDecorator.js"
import { createSqlOutboxRepository } from "./outboxRepository.sql.js"
import { createSqlSyncStateRepository } from "./syncStateRepository.sql.js"
import { createSqlSyncApplyRepository } from "./syncApplyRepository.sql.js"
import { createSqlSyncBackfillRepository } from "./syncBackfillRepository.sql.js"

export { createSqlSchemeVersionRepository } from "./schemeVersionRepository.sql.js"
export { createSqlNoteRepository } from "./notesRepository.sql.js"
export { createSqlPlaylistItemRepository } from "./playlistItemsRepository.sql.js"
export { createSqlLibraryItemRepository } from "./libraryItemsRepository.sql.js"
export { createSqlLibraryMembershipRepository } from "./libraryMembershipsRepository.sql.js"
export { createSqlListeningSessionRepository } from "./listeningSessionsRepository.sql.js"
export { createSqlMediaItemRepository } from "./mediaItemsRepository.sql.js"
export { createSqlUnitOfWork } from "./unitOfWork.sql.js"
export { createSqlTrackRepository } from "./tracksRepository.sql.js"
export { createSqlAuthorRepository } from "./authorsRepository.sql.js"
export { createSqlLocationRepository } from "./locationsRepository.sql.js"
export { createSqlSourceRepository } from "./sourcesRepository.sql.js"
export { createSqlLanguageRepository } from "./languagesRepository.sql.js"
export { createSqlTagRepository } from "./tagsRepository.sql.js"
export { createSqlTopicRepository } from "./topicsRepository.sql.js"
export { createSqlChatSessionRepository } from "./chatSessionsRepository.sql.js"
export { createSqlChatMessageRepository } from "./chatMessagesRepository.sql.js"
export { createSqlProactiveStateRepository } from "./proactiveStateRepository.sql.js"
export { createSqlCollectionRepository } from "./collectionsRepository.sql.js"
export { createSqlSettingsRepository } from "./settingsRepository.sql.js"
export { createSqlDailyWisdomRepository } from "./dailyWisdomRepository.sql.js"
export { createReentrantUnitOfWork } from "./reentrantUnitOfWork.sql.js"
export { withSyncJournaling } from "./syncJournalDecorator.js"
export type { SyncJournalDeps, JournaledUserRepositories } from "./syncJournalDecorator.js"
export { createSqlOutboxRepository } from "./outboxRepository.sql.js"
export { createSqlSyncStateRepository } from "./syncStateRepository.sql.js"
export { createSqlSyncApplyRepository } from "./syncApplyRepository.sql.js"
export { createSqlSyncBackfillRepository } from "./syncBackfillRepository.sql.js"
export type {
  FeaturedCollectionRow,
  CollectionDetail,
  CollectionGroupRow,
  CollectionAuthor,
  ISqlCollectionRepository,
} from "./collectionsRepository.sql.js"

export interface SqlAppRepositories {
  readonly tracks: ReturnType<typeof createSqlTrackRepository>
  readonly authors: ReturnType<typeof createSqlAuthorRepository>
  readonly locations: ReturnType<typeof createSqlLocationRepository>
  readonly sources: ReturnType<typeof createSqlSourceRepository>
  readonly languages: ReturnType<typeof createSqlLanguageRepository>
  readonly tags: ReturnType<typeof createSqlTagRepository>
  readonly topics: ReturnType<typeof createSqlTopicRepository>
  readonly notes: ReturnType<typeof createSqlNoteRepository>
  readonly playlistItems: ReturnType<typeof createSqlPlaylistItemRepository>
  /** Personal library (epic #1236) — read-only; rows are pull-only from
   *  `profile`. Always present (does not depend on the sync `getDeviceId`
   *  gate; the sync-apply adapter fills the table when the engine runs). */
  readonly libraryItems: ReturnType<typeof createSqlLibraryItemRepository>
  /** The user's remove/re-add intent for library items (epic #1236) — CLIENT-
   *  owned and synced, wrapped by the journal decorator when the sync engine is
   *  enabled. The store joins it against `libraryItems` to hide removed items. */
  readonly libraryMemberships: ReturnType<typeof createSqlLibraryMembershipRepository>
  readonly listeningSessions: ReturnType<typeof createSqlListeningSessionRepository>
  readonly mediaItems: ReturnType<typeof createSqlMediaItemRepository>
  readonly unitOfWork: ReturnType<typeof createReentrantUnitOfWork>
  readonly chatSessions: ReturnType<typeof createSqlChatSessionRepository>
  readonly chatMessages: ReturnType<typeof createSqlChatMessageRepository>
  readonly proactiveState: ReturnType<typeof createSqlProactiveStateRepository>
  readonly collections: ReturnType<typeof createSqlCollectionRepository>
  readonly settings: ReturnType<typeof createSqlSettingsRepository>
  readonly dailyWisdom: ReturnType<typeof createSqlDailyWisdomRepository>
  /**
   * Profile-sync engine repositories (Lane D). Present only when `getDeviceId`
   * is wired — the same gate that enables journaling. `undefined` on web /
   * before the engine is enabled, where the sync engine never runs. The
   * composable is the runtime gate; these are the ports it hands the engine.
   */
  readonly syncOutbox?: ReturnType<typeof createSqlOutboxRepository>
  readonly syncState?: ReturnType<typeof createSqlSyncStateRepository>
  readonly syncApply?: ReturnType<typeof createSqlSyncApplyRepository>
  /**
   * First-sync backfill reader (Lane E2b). Present under the same `getDeviceId`
   * gate as the engine repos; enumerates pre-journaling local rows so the
   * `backfillLocal` use case can enqueue them the first time a real account
   * signs in on this device.
   */
  readonly syncBackfill?: ReturnType<typeof createSqlSyncBackfillRepository>
}

export interface CreateSqlAppRepositoriesDeps {
  readonly contentDb: IDatabase
  readonly userDb: IDatabase
  /**
   * Read on every query that depends on the active UI language (e.g. the
   * tracks repo's by-reference sort joins to track_variants for this code).
   */
  readonly getActiveLanguage: () => LanguageCode
  /**
   * Resolves this device's stable id (the HLC tiebreak for profile sync).
   * When provided, the synced user repositories (`notes`, `playlistItems`,
   * `listeningSessions`) are wrapped so every mutation is journaled into the
   * `outbox` in the same transaction. Omit it (e.g. web, or before the sync
   * engine is wired) to disable journaling — the plain repositories are used
   * and behaviour is unchanged.
   */
  readonly getDeviceId?: () => Promise<string>
  /**
   * Device-local "Sync chats" gate (default ON). Gates chat journaling only —
   * when it returns `false` no `chat_sessions` / `chat_messages` change is
   * journaled. Omit to leave chat sync on; it never affects the non-chat
   * collections.
   */
  readonly isChatSyncEnabled?: () => boolean
}

/**
 * Bundles every SQL-backed domain repository on top of the two open
 * databases. Scoped to *SQL* adapters only — HTTP-backed repos (like
 * transcripts) are wired in the composition root (`lectorium/`),
 * because a sibling-infra import would violate the layer rules.
 */
export function createSqlAppRepositories(deps: CreateSqlAppRepositoriesDeps): SqlAppRepositories {
  // One reentrant unit-of-work is shared between the bundle and the
  // sync-journal decorator so a journal entry can join the caller's open
  // transaction (see reentrantUnitOfWork.sql.ts). It's a strict superset of
  // the plain unit-of-work's behaviour (identical when un-nested), so it is
  // safe for every existing caller.
  const unitOfWork = createReentrantUnitOfWork(deps.userDb)

  // The synced user-data repositories. When a device id is available they are
  // wrapped so every mutation is journaled to the outbox atomically. Chat is
  // wrapped too but its journaling is additionally gated by `isChatSyncEnabled`.
  const baseSynced = {
    notes: createSqlNoteRepository(deps.userDb),
    playlistItems: createSqlPlaylistItemRepository(deps.userDb),
    listeningSessions: createSqlListeningSessionRepository(deps.userDb),
    chatSessions: createSqlChatSessionRepository(deps.userDb),
    chatMessages: createSqlChatMessageRepository(deps.userDb),
    libraryMemberships: createSqlLibraryMembershipRepository(deps.userDb),
  }
  const synced = deps.getDeviceId
    ? withSyncJournaling(baseSynced, {
        userDb: deps.userDb,
        unitOfWork,
        getDeviceId: deps.getDeviceId,
        isChatSyncEnabled: deps.isChatSyncEnabled,
      })
    : baseSynced

  // Sync-engine repositories share the same userDb + reentrant unit-of-work as
  // the journaling decorator, so a pull-merge batch and an outbox drain are
  // each one atomic transaction. Built only when a device id is available —
  // the same gate that enables journaling; without it the engine never runs.
  const getDeviceId = deps.getDeviceId
  const syncRepos = getDeviceId
    ? {
        syncOutbox: createSqlOutboxRepository(deps.userDb),
        syncState: createSqlSyncStateRepository(deps.userDb, getDeviceId),
        syncApply: createSqlSyncApplyRepository(deps.userDb),
        syncBackfill: createSqlSyncBackfillRepository(deps.userDb, deps.isChatSyncEnabled),
      }
    : {}

  // Read-only + pull-only: the client never writes library_items. Built here
  // (not inline below) so the corpus track repo can be composed with it into a
  // single track source — a track lives in EITHER the corpus or the personal
  // library, and both resolve to the same `Track` so the whole app (playlist /
  // Up Next / player / sheet) treats them identically.
  const libraryItems = createSqlLibraryItemRepository(deps.userDb)

  return {
    ...syncRepos,
    tracks: createCompositeTrackRepository(
      createSqlTrackRepository({
        contentDb: deps.contentDb,
        getActiveLanguage: deps.getActiveLanguage,
      }),
      libraryItems
    ),
    authors: createSqlAuthorRepository(deps.contentDb),
    locations: createSqlLocationRepository(deps.contentDb),
    sources: createSqlSourceRepository(deps.contentDb),
    languages: createSqlLanguageRepository(deps.contentDb),
    tags: createSqlTagRepository(deps.contentDb),
    topics: createSqlTopicRepository(deps.contentDb),
    notes: synced.notes,
    playlistItems: synced.playlistItems,
    libraryItems,
    libraryMemberships: synced.libraryMemberships,
    listeningSessions: synced.listeningSessions,
    mediaItems: createSqlMediaItemRepository(deps.userDb),
    unitOfWork,
    chatSessions: synced.chatSessions,
    chatMessages: synced.chatMessages,
    proactiveState: createSqlProactiveStateRepository(deps.userDb),
    collections: createSqlCollectionRepository(deps.contentDb),
    settings: createSqlSettingsRepository(deps.contentDb),
    dailyWisdom: createSqlDailyWisdomRepository(deps.contentDb),
  }
}
