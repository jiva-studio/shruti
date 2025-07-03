import { Events, Slots } from '@lectorium/mobile/events'
import { useTrackStateStore } from './useTrackStateStore'


export type Options = {
  downloaderGetTasksSlot: typeof Slots.getDownloaderTasks
  downloaderTaskFailedEvent: typeof Events.downloaderTaskFailed
  downloaderTaskStatusEvent: typeof Events.downloaderTaskStatus
  downloaderTaskEnqueuedEvent: typeof Events.downloaderTaskEnqueued
}

export function useSyncDownloadingStateTask(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const trackStateStore = useTrackStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  options.downloaderTaskEnqueuedEvent.subscribe(async event => {
    if (!event.meta.trackId) { return }
    trackStateStore.setState(event.meta.trackId, { downloadProgress: 0 })
  })

  options.downloaderTaskStatusEvent.subscribe(async event => {
    if (!event.meta.trackId) { return }
    const tasksRelatedToTrack = options.downloaderGetTasksSlot.call()
      .filter(x => x.meta.trackId === event.meta.trackId)
    const downloadProgress = Math.min(...tasksRelatedToTrack.map(x => x.progress || 0))
    trackStateStore.setState(event.meta.trackId, { downloadProgress })
  })

  options.downloaderTaskFailedEvent.subscribe(async event => {
    if (!event.meta.trackId) { return }
    trackStateStore.setState(event.meta.trackId, { downloadFailed: true })
  })
}