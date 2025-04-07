import PouchDB from 'pouchdb'
import PouchDBFind from 'pouchdb-find'

PouchDB.plugin(PouchDBFind)

export interface DatabaseConfig {
  name: string,
  adapter?: string,
}

export interface DatabaseReplicationChangeEvent {
  documentsPending: number,
  docs: any[]
}

export interface DatabaseReplicationOptions {
  filter?: string | ((doc: any, params: any) => any) | undefined;
  doc_ids?: string[],
  query_params?: Record<string, any>
  style?: string
  onChange?: (event: DatabaseReplicationChangeEvent) => void
}

export class Database {
  private _db: PouchDB.Database
  private _config: DatabaseConfig

  /**
   * Initialize a new database using the given configuration
   * @param config Database configuration
   */
  constructor(
    config: DatabaseConfig
  ) {
    this._config = config
    this._db = new PouchDB(this._config.name, {
      adapter: this._config.adapter,
      // @ts-ignore
      location: 'default',
    })
  }

  /**
   * Replicate the local database from a remote database
   */
  async replicateFrom(
    source: Database,
    options?: DatabaseReplicationOptions,
  ) {
    await this._db.replicate
      .from(source.db, options)
      .on('change', info => {
        options?.onChange && options.onChange({
          // @ts-ignore
          documentsPending: info.pending || 0,
          docs: info.docs
        })
      })
  }

  async sync(
    remote: Database,
    options?: DatabaseReplicationOptions,
  ) {
    await this._db.sync(remote.db, options)
  }

  /**
   * Get the underlying PouchDB instance
   */
  get db() { return this._db }
}
