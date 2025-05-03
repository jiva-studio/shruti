import { watch } from 'vue'
import { App } from '@capacitor/app'
import { ItemChangedEvent } from '@lectorium/dal/services/DatabaseService'
import { useDAL, useDownloaderService } from '@lectorium/mobile/app'
import { useTimeoutPoll } from '@vueuse/core'
import { useDownloadsStore, DownloadTask } from '../stores/useDownloadsStore'
import { MediaItem } from '@lectorium/dal/models'
import { useTrackStateStore } from '../stores'

/**
 * Downloader Feature
 * 
 * Coordinates and synchronizes various components of the application to ensure
 * a seamless and efficient downloading experience.
 */
export function useDownloaderFeature() {

  const terminalStates = ['failed', 'successful']


  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const downloadsStore = useDownloadsStore()
  const trackStateStore = useTrackStateStore()
  const downloadsService = useDownloaderService()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  // Poll statuses of running downloads
  const poll = useTimeoutPoll(pollDownloadTasksStatuses, 1000, { immediate: true })
  
  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.mediaItems.subscribe(onMediaItemChanged)

  // downloadsService.onDownloadComplete(
  //   async ({ taskId, status }) => await onDownloadComplete(taskId, status)
  // )

  App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) { return }
    await addIncomleteMediaItemsToStore()
  })

  watch(() => downloadsStore.count(), (count) => {
    if (count > 0) {
      poll.resume()
    } else {
      poll.pause()
    }
  }, { immediate: true })

  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onMediaItemChanged(
    event: ItemChangedEvent<MediaItem>
  ) {
    if (event.event !== 'added') { return }
    downloadsStore.add({
      mediaItemId: event.item._id,
      taskId: event.item.taskId,
      trackId: event.item.trackId,
      state: 'running',
      progress: 0,
    })
  }

  async function onDownloadComplete(
    taskId: string,
    status: 'successful' | 'failed',
  ) {
    // get media item by taskId
    const mediaItem = await dal.mediaItems.findOne({ taskId })
    console.log(
      `Download ${taskId} completed with status: `+
      `${mediaItem?.taskStatus ?? 'unknown'} -> ${status}`)

    // update media item status if necessary
    if (mediaItem && mediaItem.taskStatus !== status) {
      mediaItem.taskStatus = status
      await dal.mediaItems.updateOne(mediaItem._id, mediaItem)
      console.log('Media item status updated:', mediaItem._id, mediaItem.taskStatus)
    } 

    if (mediaItem?._id) {
      updateTrackProgress(mediaItem.trackId)
      downloadsStore.remove(mediaItem?._id)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function updateTrackProgress(trackId: string) {
    const tasks = downloadsStore.all().filter(x => x.trackId === trackId)
    const progress = Math.min(...tasks.map(x => x.progress))
    const hasFailedTasks = tasks.some(x => x.state === 'failed')

    if (progress >= 100 && !hasFailedTasks) {
      trackStateStore.setStatus(trackId, { 
        downloadProgress: 100, 
        downloadFailed: undefined,
        inPlaylist: true 
      })
    } else if (hasFailedTasks) {
      trackStateStore.setStatus(trackId, { 
        downloadFailed: true 
      })
    } else {
      trackStateStore.setStatus(trackId, { downloadProgress: progress })
    }
  }
  
  /**
   * Adds information to downloads store about incomplete media items
   */
  async function addIncomleteMediaItemsToStore() {
    const running = await dal.mediaItems.getMany({
      selector: { taskStatus: { $in: ['running', 'failed'] } },
    })

    for (const mediaItem of running) {
      downloadsStore.add({
        mediaItemId: mediaItem._id,
        taskId: mediaItem.taskId,
        trackId: mediaItem.trackId,
        state: mediaItem.taskStatus,
        progress: 0,
      })
    }
  }

  async function pollDownloadTasksStatuses() {
    await Promise.all(
      downloadsStore.all().map(
        async item => {
          await pollDownloadTasksStatus(item)
          updateTrackProgress(item.trackId)
        }
      )
    )    
  }

  async function pollDownloadTasksStatus(
    item: DownloadTask
  ) {
    try {
      // get status of downloading task
      const status = await downloadsService.getStatus({ taskId: item.taskId })

      // update store
      downloadsStore.update(item.mediaItemId, {
        progress: status.progress,
        state: status.status
      })

      // update media item if downloading in final stage and remove
      // task from store
      if (terminalStates.includes(status.status)) {
        await onDownloadComplete(
          item.taskId, 
          status.status as 'successful' | 'failed'
        ) 
      }
    } catch (e) {
      console.error('Error while polling', JSON.stringify(e))
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  async function init() {
    await addIncomleteMediaItemsToStore()
  }

  return { init }
}