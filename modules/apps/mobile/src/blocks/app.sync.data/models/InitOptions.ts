import { Database } from '@lectorium/dal/persistence'

type SyncDatabases = {
  index: Database
  tracks: Database
  dictionary: Database
  userData?: Database
}

export type InitOptions = {
  local: () => SyncDatabases
  remote: () => SyncDatabases
}