import { Events, Slots } from '@lectorium/mobile/events'
import { Filesystem, Directory, ProgressStatus } from '@capacitor/filesystem'
import { createSharedComposable } from '@vueuse/core'
import { useLogger } from '../../app.core'

type DownloaderTask = {
  url: string
  destination: string
  progress: number
  meta: any
}

type Options = {
  downloaderTaskFailedEvent: typeof Events.downloaderTaskFailed
  downloaderTaskStatusEvent: typeof Events.downloaderTaskStatus
  downloaderTaskEnqueuedEvent: typeof Events.downloaderTaskEnqueued
  downloaderTaskCompletedEvent: typeof Events.downloaderTaskCompleted
  getDownloaderTasksSlot: typeof Slots.getDownloaderTasks
}

export const useDownloadingTask = createSharedComposable(async (options: Options) => {

  const logger = useLogger({ module: 'app.services.download' })

  /* -------------------------------------------------------------------------- */
  /*                                    Init                                    */
  /* -------------------------------------------------------------------------- */

  await Filesystem.addListener('progress', (e) => onProgressUpdate(e))
  options.getDownloaderTasksSlot.connect(() => Object.values(tasks))


  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */ 

  const tasks: Record<string, DownloaderTask> = {}

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function enqueue(task: Omit<DownloaderTask, 'progress'>) {
    tasks[task.url] = { ...task, progress: 0 }
    options.downloaderTaskEnqueuedEvent.notify(task)

    const folder = task.destination.substring(0, task.destination.lastIndexOf('/'))

    // NOTE: downloadFile does not create the folder if it does not exist even if
    //       recursive is set to true. So we need to create the folder manually. 
    try {
      await Filesystem.mkdir({
        path: folder,
        directory: Directory.External,
        recursive: true,
      })
    } catch (e) {
      // folder already exists
    }
    
    Filesystem.downloadFile({
      url: task.url,
      path: task.destination,
      directory: Directory.External,
      recursive: true,
      progress: true,
    }).catch((e) => {
      logger.error('Download failed: '  + task.url + ' ' + JSON.stringify(e))
      options.downloaderTaskFailedEvent.notify(tasks[task.url])
    })
  }

  function onProgressUpdate(status: ProgressStatus) {
    const progress = status.bytes / status.contentLength * 100
    tasks[status.url].progress = progress
    options.downloaderTaskStatusEvent.notify(tasks[status.url])
    
    if (status.bytes === status.contentLength) {
      options.downloaderTaskCompletedEvent.notify(tasks[status.url])
      logger.info('Download completed: ' + JSON.stringify(tasks[status.url]))
      delete tasks[status.url]
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { enqueue }
})