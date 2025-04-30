import PouchDB from 'pouchdb'
import PouchDBFind from 'pouchdb-find'

PouchDB.plugin(PouchDBFind)

/* -------------------------------------------------------------------------- */
/*                                Configuration                               */
/* -------------------------------------------------------------------------- */

export type IndexConfig = {
  name: string
  fields: string[],
}

export interface DatabaseConfig {
  name: string,
  adapter?: string,
  indices?: IndexConfig[],
  authToken?: () => string
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
  /*                                 Replication                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Replicate the local database from a remote database
   */
  async replicateFrom(
    source: Database,
    options?: DatabaseReplicationOptions,
  ) {
    await this._db.replicate
      .from(source.db, options)
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
