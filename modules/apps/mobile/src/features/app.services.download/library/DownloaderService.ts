import { Filesystem, Directory, ProgressStatus } from '@capacitor/filesystem'
import { Event } from '@lectorium/mobile/features/app.core'

/* -------------------------------------------------------------------------- */
/*                                   Models                                   */
/* -------------------------------------------------------------------------- */

export type DownloaderTask = {
  url: string
  destination: string
  progress: number
  meta: any
}


/* -------------------------------------------------------------------------- */
/*                                  Requests                                  */
/* -------------------------------------------------------------------------- */

export type DownloaderEnqueueTaskRequest = 
  Pick<DownloaderTask, 'url' | 'destination' | 'meta'>

/* -------------------------------------------------------------------------- */
/*                                 Event Args                                 */
/* -------------------------------------------------------------------------- */

export type DownloaderStatusEventArgs = DownloaderTask;

export type DownloaderTaskEnqueuedEventArgs = DownloaderEnqueueTaskRequest

export type DownloaderTaskCompletedEventArgs = DownloaderTask
export type DownloaderTaskFailedEventArgs = DownloaderTask


/**
 * DownloaderService is a service that handles downloading
 * files from a URL to a local destination.
 */
export class DownloaderService {
  private _tasks: Record<string, DownloaderTask> = {}
  private _statusEvent        = new Event<DownloaderStatusEventArgs>()
  private _taskEnqueuedEvent  = new Event<DownloaderTaskEnqueuedEventArgs>()
  private _taskCompletedEvent = new Event<DownloaderTaskCompletedEventArgs>()
  private _taskFailedEvent    = new Event<DownloaderTaskFailedEventArgs>()

  /**
   * Creates an instance of DownloaderService.
   */
  constructor() {
    Filesystem.addListener('progress', (e) => this.onProgressUpdate(e))
    this.enqueuedEvent.subscribe((event: DownloaderTaskEnqueuedEventArgs) => {
      this._tasks[event.url] = { ...event, progress: 0 }
    })
    this.statusEvent.subscribe((event: DownloaderStatusEventArgs) => {
      this._tasks[event.url].progress = event.progress
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async enqueue(
    request: DownloaderEnqueueTaskRequest
  ) {
    this._taskEnqueuedEvent.notify(request)

    const folder = request.destination.substring(0, request.destination.lastIndexOf('/'))

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
      url: request.url,
      path: request.destination,
      directory: Directory.External,
      recursive: true,
      progress: true,
    }).catch((e) => {
      console.warn('Download failed', request.url, JSON.stringify(e))
      this._taskFailedEvent.notify(this._tasks[request.url])
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                 Properties                                 */
  /* -------------------------------------------------------------------------- */

  get tasks() {
    return Object.values(this._tasks)
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Events                                   */
  /* -------------------------------------------------------------------------- */

  get enqueuedEvent() {
    return this._taskEnqueuedEvent
  }

  get completedEvent() {
    return this._taskCompletedEvent
  }

  get failedEvent() {
    return this._taskFailedEvent
  }
  
  get statusEvent() {
    return this._statusEvent
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Private                                  */
  /* -------------------------------------------------------------------------- */

  private onProgressUpdate(status: ProgressStatus) {
    const progress = status.bytes / status.contentLength * 100
    this.statusEvent.notify({ ...this._tasks[status.url], progress })

    if (status.bytes === status.contentLength) {
      this._taskCompletedEvent.notify(this._tasks[status.url])
      delete this._tasks[status.url]
    }
  }
}
