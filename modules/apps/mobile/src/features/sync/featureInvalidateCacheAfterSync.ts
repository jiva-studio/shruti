import { useEventBus } from '@shruti/mobile/core'
import { useDAL } from '@blocks/app.database'

export async function featureInvalidateCacheAfterSync() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.syncComplete.subscribe(async (event) => {
    const hasChangesFor = (type: string) => {
      return event.commonData.pull?.docs?.some(doc => doc.type === type)
    }

    if (hasChangesFor('tag'))      { dal.tags.invalidateCache() }
    if (hasChangesFor('author'))   { dal.authors.invalidateCache() }
    if (hasChangesFor('source'))   { dal.sources.invalidateCache() }
    if (hasChangesFor('location')) { dal.locations.invalidateCache() }
    if (hasChangesFor('language')) { dal.languages.invalidateCache() }
    if (hasChangesFor('duration')) { dal.durations.invalidateCache() }
    if (hasChangesFor('sort'))     { dal.sortMethods.invalidateCache() }
  })
}