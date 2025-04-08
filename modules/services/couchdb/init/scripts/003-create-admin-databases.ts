import { Migration } from './Migration'

export abstract class CreateAdminDatabase extends Migration {
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

export class CreateTracksInboxDatabase extends CreateAdminDatabase {
  get dbName(): string { return `inbox` }
}

export class CreateTracksSourcesDatabase extends CreateAdminDatabase {
  get dbName(): string { return `sources` }
}
