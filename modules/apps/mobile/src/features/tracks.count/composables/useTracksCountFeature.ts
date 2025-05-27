import { createSharedComposable } from '@vueuse/core'
import { TracksService } from '@lectorium/dal/index'
import { useTracksCountStore } from './useTracksCountStore'

export type Options = {
  tracksService: TracksService
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
    tracksCountStore.totalCount = await options.tracksService.getCount()
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init
  }
})