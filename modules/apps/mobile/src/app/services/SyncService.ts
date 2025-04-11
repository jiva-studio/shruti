import { Database } from "@lectorium/dal/persistence"

export type SyncDatabases = {
  tracks: Database
  transcripts: Database
  dictionary: Database
  index: Database
}

export class SyncService {
  local: SyncDatabases
  remote: SyncDatabases

  constructor(databases: { local: SyncDatabases, remote: SyncDatabases }) {
    this.local = databases.local
    this.remote = databases.remote
  }

  async sync() {
    const baseFilter = (doc: {_id:string}) => { return !doc._id.startsWith('_design/'); }

    await Promise.all([
      this.local.tracks.replicateFrom(this.remote.tracks, { filter: baseFilter }),
      this.local.dictionary.replicateFrom(this.remote.dictionary, { filter: baseFilter }),
      this.local.index.replicateFrom(this.remote.index, { filter: baseFilter }),
      // TODO: replicate required transcripts only
      this.local.transcripts.replicateFrom(this.remote.transcripts, { filter: baseFilter }),
    ])
  }
}