import { Migration } from './Migration'

export abstract class CreateLibraryDatabase extends Migration {
  abstract get dbName(): string

  get name(): string { return `Create ${this.dbName} database` }

  async shouldMigrate(): Promise<boolean> {
    try {
      await this.server.db.get(this.dbName)
      return false // Database exists
    } catch (error) {
      return true // Database does not exist
    }
  }

  async migrate(): Promise<void> {
    await this.server.db.create(this.dbName)

    // Make database publicly readable
    await this.server.request({
      db: this.dbName,
      method: 'PUT',
      doc: '_security',
      body: {
        admins:  { names: [], roles: [ "_admin" ] },
        members: { names: [], roles: [ ] },
      }
    })

    // Make database only writable by users with the contentManager
    // role or the _admin role
    await this.server.request({
      db: this.dbName,
      method: 'PUT',
      doc: '_design/permissions',
      body: {
        // @ts-ignore
        validate_doc_update: function(newDoc, oldDoc, userCtx, secObj) {
          const isContentManager = userCtx.roles.indexOf('contentManager') !== -1
          const isAdmin          = userCtx.roles.indexOf('_admin') !== -1
          if (!isContentManager && !isAdmin) {
            throw ({ forbidden: 'You are not a content manager.' })
          }
        }.toString()
      }
    })
  }

  async revert(): Promise<void> {
    await this.server.db.destroy(this.dbName)
  }
}

export class CreateLibraryTracksDatabase extends CreateLibraryDatabase {
  get dbName(): string { return `tracks` }
}

export class CreateLibraryTranscriptsDatabase extends CreateLibraryDatabase {
  get dbName(): string { return `transcripts` }

  override async migrate(): Promise<void> {
    await super.migrate()

    await this.server.request({
      db: this.dbName,
      method: 'PUT',
      doc: '_design/library',
      body: {
        filters: {
          // @ts-ignore
          by_id: function (doc, req) {
            const idTokens = doc._id.split("::");

            // Transcript ID format: <trackId>::<languageCode>
            if (idTokens.length !== 2) { return false; }

            // Extract document information from ID
            const trackId = idTokens[0];
            const requestedTrackIds = req.query.ids;

            // Check if the track ID is in the requested track IDs
            return requestedTrackIds.includes(trackId)
          },
        }
      }
    })
  }
}

export class CreateLibraryDictionaryDatabase extends CreateLibraryDatabase {
  get dbName(): string { return `dictionary` }
}

export class CreateLibraryIndexDatabase extends CreateLibraryDatabase {
  get dbName(): string { return `index` }
}
