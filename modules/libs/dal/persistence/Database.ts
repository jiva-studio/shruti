import PouchDB from 'pouchdb'
import PouchDBFind from 'pouchdb-find'

PouchDB.plugin(PouchDBFind)

/* -------------------------------------------------------------------------- */
/*                                Configuration                               */
/* -------------------------------------------------------------------------- */

export type IndexConfig = {
  name: string
  fields: string[],
  partial_filter_selector?: PouchDB.Find.Selector | undefined;
}

export interface DatabaseConfig {
  name: string,
  adapter?: string,
  indices?: IndexConfig[],
  authToken?: () => string
}

export type SyncResult = {
  pull?: { docs: any[] }
  push?: { docs: any[] }
}
/* -------------------------------------------------------------------------- */
/*                                 Replication                                */
/* -------------------------------------------------------------------------- */

export interface DatabaseReplicationOptions {
  filter?: string | ((doc: any, params: any) => any) | undefined;
  doc_ids?: string[],
  query_params?: Record<string, any>
  style?: string
}


/* -------------------------------------------------------------------------- */
/*                                  Database                                  */
/* -------------------------------------------------------------------------- */

export class Database {
  private _db: PouchDB.Database
  private _config: DatabaseConfig
  private _factory: (config: DatabaseConfig) => PouchDB.Database 

  /**
   * Initialize a new database using the given configuration
   * @param config Database configuration
   */
  constructor(
    config: DatabaseConfig
  ) {
    this._config = config
    this._factory = () => new PouchDB(this._config.name, {
      adapter: this._config.adapter,
      // @ts-ignore
      location: 'default',
      fetch: (url: string | Request, opts: RequestInit | undefined) => {
        // Add Authorization header to the request options
        const token = this._config.authToken ? this._config.authToken() : null
        if (opts && token) {
          const headers = new Headers(opts.headers);
          headers.set('Authorization', `Bearer ${token}`);
          opts.headers = headers;
        }
        return PouchDB.fetch(url, opts);
      }
    })
    this._db = this._factory(config)
  }

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Initializes the database.
   */
  async init() {
    for (const index of this._config.indices || []) {
      await this._db.createIndex({ index })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Destroy                                  */
  /* -------------------------------------------------------------------------- */

  async destroy() {
    await this._db.destroy()
    this._db = this._factory(this._config)
  }

  /* -------------------------------------------------------------------------- */
  /*                                 Replication                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Replicate the local database from a remote database
   */
  async replicateFrom(
    source: Database,
    options?: DatabaseReplicationOptions,
  ) : Promise<SyncResult> {
    const pullChanges: PouchDB.Core.ExistingDocument<{}>[] = []

    await this._db.replicate
      .from(source.db, options)
      .on('change', (info) => { pullChanges.push(...info.docs) })
    return { pull: { docs: pullChanges } }
  }

  async sync(
    remote: Database,
    options?: DatabaseReplicationOptions,
  ) : Promise<SyncResult> {
    const pushChanges: PouchDB.Core.ExistingDocument<{}>[] = []
    const pullChanges: PouchDB.Core.ExistingDocument<{}>[] = []

    const syncResult = await this._db
      .sync(remote.db, options)
      .on('change', (info) => {
        if (info.direction === 'pull') {
          pullChanges.push(...info.change.docs)
        } else if (info.direction === 'push') {
          pushChanges.push(...info.change.docs)
        }
      })

    // Enhance the result with pull and push changes
    if (syncResult.pull) { syncResult.pull.docs = pullChanges }
    if (syncResult.push) { syncResult.push.docs = pushChanges }

    // Return the sync result
    return syncResult
  }

  /**
   * Get the underlying PouchDB instance
   */
  get db() { return this._db }
}
