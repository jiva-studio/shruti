import { useDatabase } from '@lectorium/admin/shared'

export function useSync() {
  const database = useDatabase()

  async function sync() {
    await database.local.dictionary.replicateFrom(database.remote.dictionary, {
      filter: (doc) => {
        return !doc._id.startsWith('_design/')
      },
    })
    await database.local.inbox.sync(database.remote.inboxTracks, {
      filter: (doc) => {
        return !doc._id.startsWith('_design/')
      },
    })
  }

  return { sync }
}
