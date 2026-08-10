import type { IDatabase, IRemoteFilesStorage, IStoragePublicUrl } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import { createHttpTranscriptRepository } from "@infra/repositories/http/index.js"
import { createSqlAppRepositories, type SqlAppRepositories } from "@infra/repositories/sql/index.js"

/**
 * Composition-root bundle of every domain-facing repository the app
 * needs. Lives here (not inside `@infra/*`) so that the SQL and HTTP
 * sibling adapters stay decoupled — the layer rules forbid sibling
 * infra imports, so their composition is the composition root's job.
 */
export interface AppRepositories extends SqlAppRepositories {
  readonly transcripts: ReturnType<typeof createHttpTranscriptRepository>
}

export interface CreateAppRepositoriesDeps {
  readonly contentDb: IDatabase
  readonly userDb: IDatabase
  readonly filesStorage: IRemoteFilesStorage
  readonly storagePublicUrl: IStoragePublicUrl
  /**
   * Read at SQL-build time inside repositories that need the active UI
   * language (currently only the tracks repo, for by-reference sort).
   * Wired from `useAppLanguage` at app bootstrap so a runtime locale
   * switch reflects on the next query without re-creating repos.
   */
  readonly getActiveLanguage: () => LanguageCode
  /**
   * Resolves this device's stable id. When provided, the synced user
   * repositories are journaled to the outbox and the sync-engine repositories
   * (`syncOutbox` / `syncState` / `syncApply`) are built. Omit to disable sync.
   */
  readonly getDeviceId?: () => Promise<string>
  /**
   * Resolves the account that owns the device right now. Stamped on every
   * journaled row so the push path can scope the outbox to its own account
   * (#1497). Wired from the auth session at the composition root, so an
   * account switch is reflected on the next write without rebuilding repos.
   *
   * **Required**, unlike the infra-level dep it forwards to. Nothing observable
   * breaks when this goes missing — rows just journal unowned and the whole
   * ownership mechanism degrades, silently, to the watermark scheme it
   * replaced. The type is the guard: dropping the wiring fails the build.
   */
  readonly getOwnerId: () => string | null
  /**
   * Device-local "Sync chats" gate (default ON). Gates chat journaling only.
   * Wired from `useSyncChatsEnabled` at the composition root so a runtime
   * toggle flip is reflected on the next chat write without rebuilding repos.
   */
  readonly isChatSyncEnabled?: () => boolean
}

export function createAppRepositories(deps: CreateAppRepositoriesDeps): AppRepositories {
  const sql = createSqlAppRepositories({
    contentDb: deps.contentDb,
    userDb: deps.userDb,
    getActiveLanguage: deps.getActiveLanguage,
    getDeviceId: deps.getDeviceId,
    getOwnerId: deps.getOwnerId,
    isChatSyncEnabled: deps.isChatSyncEnabled,
  })
  return {
    ...sql,
    transcripts: createHttpTranscriptRepository({
      tracks: sql.tracks,
      filesStorage: deps.filesStorage,
      storagePublicUrl: deps.storagePublicUrl,
    }),
  }
}
