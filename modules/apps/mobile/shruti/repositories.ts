import type { IDatabase, IRemoteFilesStorage, IStoragePublicUrl } from "@ports/app/index.js"
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
}

export function createAppRepositories(deps: CreateAppRepositoriesDeps): AppRepositories {
  const sql = createSqlAppRepositories({
    contentDb: deps.contentDb,
    userDb: deps.userDb,
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
