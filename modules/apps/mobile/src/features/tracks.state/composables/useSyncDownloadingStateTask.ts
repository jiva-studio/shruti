import { useTrackStateStore } from './useTrackStateStore'

export type EventArgs = { progress?: number, meta: any } 
export type EventHandler = (event: EventArgs) => void

export type Options = {
  subscribeTaskEnqueued: (handler: EventHandler) => void
  subscribeTaskStatus: (handler: EventHandler) => void
  subscribeTaskFailed: (handler: EventHandler) => void
  getTasks: () =>  Array<{ meta: any, progress?: number }>
}

export function useSyncDownloadingStateTask(
  options: Options
) {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const trackStateStore = useTrackStateStore()


  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  function onDownloaderTaskEnqueued(
    event: EventArgs
  ) {
    if (!event.meta.trackId) { return }
    trackStateStore.setState(event.meta.trackId, { downloadProgress: 0 })
  }

  function onDownloaderStatus(
    event: EventArgs
  ) {
    if (!event.meta.trackId) { return }
    const tasksRelatedToTrack = options.getTasks()
      .filter(x => x.meta.trackId === event.meta.trackId)
    const downloadProgress = Math.min(...tasksRelatedToTrack.map(x => x.progress || 0))
    trackStateStore.setState(event.meta.trackId, { downloadProgress })
  }

  function onDownloaderTaskFailed(
   event: EventArgs
  ) {
    if (!event.meta.trackId) { return }
    trackStateStore.setState(event.meta.trackId, { downloadFailed: true })
  }

  function start() {
    options.subscribeTaskEnqueued(onDownloaderTaskEnqueued)
    options.subscribeTaskStatus(onDownloaderStatus)
    options.subscribeTaskFailed(onDownloaderTaskFailed)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { start }
}