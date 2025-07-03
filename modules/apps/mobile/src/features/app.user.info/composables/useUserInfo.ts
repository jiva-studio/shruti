import { Database } from '@lectorium/dal/persistence'

export type UserInfo = {
  name?: string
  email?: string
  avatarUrl?: string
}

export function useUserInfo(options: {
  database: Database
}) {
  const documentId = 'userInfo'

  /**
   * Saves user information to the database.
   * If the document already exists, it enriches it with the provided user info.
   * 
   * @param userInfo - The user information to save.
   */
  async function save(userInfo: UserInfo) {
    let doc: UserInfo = {}
    try {
      doc = await options.database.db.get<UserInfo>('userInfo')
    } catch(a) { 
      // document not found
    }

    // enrich document with user info
    doc.name      ??= userInfo.name
    doc.email     ??= userInfo.email
    doc.avatarUrl ??= userInfo.avatarUrl

    // save document
    try {
      await options.database.db.put({ 
        _id: documentId, 
        type: 'system', 
        ...doc
      })
    } catch(a) { 
      // unable to save
    }
  }

  async function load(): Promise<UserInfo | undefined> { 
    let doc: any = {}
    const db = options.database.db

    // Step 1: Load the document with conflicts. Conficts can occur when
    //         we authenticate and user info document, and then we sync 
    //         with remote database, which already has a user info document.
    try {
      doc = await db.get(documentId, { conflicts: true })
    } catch(a) { 
      // unable to load user info
      return
     }

    // If there are no conflicts, just return. No user info document
    // were saved on remote database.
    if (!doc._conflicts || doc._conflicts.length === 0) {
      return doc
    }

    // Step 2: Fetch all conflicting revisions
    const conflicts = await Promise.all(
      doc._conflicts.map((rev:any) => db.get(documentId, { rev }))
    )

    // Step 3: Merge the document with conflicts
    const merged = {
      ...doc,
      _rev: doc._rev,
      ...conflicts.reduce((acc, doc) => {
        Object.entries(doc).forEach(([key, value]) => {
          if (!acc[key] && !key.startsWith('_') && value) {
            acc[key] = value
          }
        })
        return acc
      }, {} as Record<string, any>),
    }

    // Step 4: Save merged document as new revision
    await options.database.db.put(merged)

    // Step 5: Remove all conflicting revisions
    await Promise.all(
      conflicts.map(doc => options.database.db.remove(doc._id, doc._rev))
    )

    return merged
  }

  return { save, load }
}