import { Event } from '@lectorium/mobile/features/app.core'
import { S3SignedUrlRequest, S3SignedUrlResponse } from '@lectorium/protocol/index'

export interface IBucketService {
  getSignedUrl(request: S3SignedUrlRequest): Promise<S3SignedUrlResponse>;
}

export type GetMediaRequest = {
  trackId: string,
  url: string
  destination: string
}

export interface IMediaService {
  get(request: GetMediaRequest): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                             Downloader Service                             */
/* -------------------------------------------------------------------------- */

export type DownloaderTask = {
  url: string
  destination: string
  progress: number
  meta: any
}

export type DownloaderEnqueueTaskRequest = 
  Pick<DownloaderTask, 'url' | 'destination' | 'meta'>


export type DownloaderStatusEventArgs = DownloaderTask;
export type DownloaderTaskEnqueuedEventArgs = DownloaderEnqueueTaskRequest
export type DownloaderTaskCompletedEventArgs = DownloaderTask
export type DownloaderTaskFailedEventArgs = DownloaderTask

/**
 * Interface for a service that handles downloading
 * files from a URL to a local destination.
 */
export interface IDownloaderService {
  tasks: DownloaderTask[];
  enqueuedEvent: Event<DownloaderTaskEnqueuedEventArgs>;
  completedEvent: Event<DownloaderTaskCompletedEventArgs>;
  failedEvent: Event<DownloaderTaskFailedEventArgs>;
  statusEvent: Event<DownloaderStatusEventArgs>;
  enqueue(request: DownloaderEnqueueTaskRequest): Promise<void>;
}
