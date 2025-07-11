import { createSharedComposable } from '@vueuse/core'
import { IRepository } from '@lectorium/dal/index'
import { useTracksCountStore } from './useTracksCountStore'
import { Track } from '@lectorium/dal/models'

export type Options = {
  tracksRepo: IRepository<Track>
}

export const useTracksCountFeature = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const tracksCountStore = useTracksCountStore()
  
  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */
  
  async function init(options: Options) {
    tracksCountStore.totalCount = await options.tracksRepo.getCount()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init
  }
})