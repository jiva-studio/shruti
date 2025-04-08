import nano from 'nano'

import { ConfigureDatabase } from './scripts/000-configure-database'
import { CreateUsersDatabase } from './scripts/001-create-users-database'
import {
  CreateLibraryTracksDatabase,
  CreateLibraryTranscriptsDatabase,
  CreateLibraryDictionaryDatabase,
  CreateLibraryIndexDatabase,
} from './scripts/002-create-library-databases'
import {
  CreateTracksInboxDatabase,
  CreateTracksSourcesDatabase,
} from './scripts/003-create-admin-databases'
import {
  CreateContentManagerUser,
} from './scripts/004-create-users'

const connectionString = process.env.CONNECTION_STRING || 'http://lectorium:lectorium@couchdb:5984'

const server = nano({ url: connectionString, parseUrl: false })
const migrations = [
  new ConfigureDatabase(server),
  new CreateUsersDatabase(server),
  new CreateLibraryTracksDatabase(server),
  new CreateLibraryTranscriptsDatabase(server),
  new CreateLibraryDictionaryDatabase(server),
  new CreateLibraryIndexDatabase(server),
  new CreateTracksInboxDatabase(server),
  new CreateTracksSourcesDatabase(server),
  new CreateContentManagerUser(server),
]

async function migrate() {
  try {
    for (const migration of migrations) {
      const shouldMigrate = await migration.shouldMigrate()
      console.log(`[${shouldMigrate ? 'MIG' : 'SKP'}] ${migration.name}`)
      if (shouldMigrate) {
        await migration.migrate()
      }
    }
  } catch (error) {
    console.error(error)
  }
}

migrate()
