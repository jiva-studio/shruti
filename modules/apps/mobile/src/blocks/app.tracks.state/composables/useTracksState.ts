import { useTracksStateStore } from './useTracksStateStore'
import { InitOptions } from '../models/InitOptions'
import { createSharedComposable } from '@vueuse/core'
import { useGetTracksIfCompletedAndArchived } from './useGetTracksIfCompletedAndArchived'
import { useGetTracksIfInPlaylist } from './useGetTracksIfInPlaylist'
import { useGetTracksIfMediaItemsFailed } from './useGetTracksIfMediaItemsFailed'
import { useGetTracksIfNoMediaItemsFound } from './useGetTracksIfNoMediaItemsFound'


export const useTracksState = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null
  const store = useTracksStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init(o: InitOptions) { options = o }
    
  /* -------------------------------------------------------------------------- */
  /*                                   Signals                                  */
  /* -------------------------------------------------------------------------- */

  async function load(
    groups: string[] = [
      'completed',
      'inPlaylist',
      'mediaItemsFailed',
      'noMediaItemsFound'
    ]
  ) {
    if (!options) { throw new Error('useTracksState is not initialized. Call init(options) first.') }

    if (groups.includes('completed')) {
      useGetTracksIfCompletedAndArchived(options).get().then(r => r.forEach(trackId => {
        store.setState(trackId, { isCompleted: true })
      }))
    }

    if (groups.includes('inPlaylist')) {
      useGetTracksIfInPlaylist(options).get().then(r => r.forEach(trackId => {
        store.setState(trackId, { inPlaylist: true })
      }))
    }

    if (groups.includes('mediaItemsFailed')) {
      useGetTracksIfMediaItemsFailed(options).get().then(r => r.forEach(trackId => {
        store.setState(trackId, { isFailed: true })
      }))
    }

    if (groups.includes('noMediaItemsFound')) {
      useGetTracksIfNoMediaItemsFound(options).get().then(r => r.forEach(trackId => {
        store.setState(trackId, { isFailed: true })
      }))
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, store, load }
})