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
}

export function createAppRepositories(deps: CreateAppRepositoriesDeps): AppRepositories {
  const sql = createSqlAppRepositories({
    contentDb: deps.contentDb,
    userDb: deps.userDb,
    getActiveLanguage: deps.getActiveLanguage,
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
