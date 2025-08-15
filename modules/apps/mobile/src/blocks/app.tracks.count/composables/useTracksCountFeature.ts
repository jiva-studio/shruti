import { createSharedComposable } from '@vueuse/core'
import { IRepository } from '@lectorium/dal'
import { useTracksCountStore } from './useTracksCountStore'
import { Track } from '@lectorium/dal'

export type Options = {
  tracksRepo: IRepository<Track>
}

export const useTracksCountFeature = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const tracksCountStore = useTracksCountStore()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: Options) {
    options = o
  }
  
  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */
  
  async function load() {
    if (!options) { throw new Error('useTracksCountFeature is not initialized.') }
    tracksCountStore.totalCount = await options.tracksRepo.getCount()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init,
    load
  }
})