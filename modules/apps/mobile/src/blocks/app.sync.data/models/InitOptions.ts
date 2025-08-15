import { Database } from '@shruti/dal'

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