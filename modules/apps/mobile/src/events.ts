import { Connection, Event } from '@lectorium/mobile/features/app.core'

export const Events = {
  /* -------------------------------------------------------------------------- */
  /*                                    Sync                                    */
  /* -------------------------------------------------------------------------- */

  syncRequested: new Event<void>('syncRequested'),
  syncTaskCompleted: new Event<{ task: 'commonData' | 'userData' | 'media' }>('syncTaskCompleted'),
  
  /* -------------------------------------------------------------------------- */
  /*                               Track Downloads                              */
  /* -------------------------------------------------------------------------- */
  
  trackDownloadRequested: new Event<{ trackId: string }>('trackDownloadRequested'),
  trackDownloadFailed: new Event<{ trackId: string }>('trackDownloadFailed'),

  /* -------------------------------------------------------------------------- */
  /*                                 Downloader                                 */
  /* -------------------------------------------------------------------------- */

  downloaderTaskEnqueueRequested: new Event<{ url: string, destination: string, meta: any}>('downloaderTaskEnqueueRequested'),
  downloaderTaskEnqueued: new Event<{ url: string, destination: string, meta: any}>('downloaderTaskEnqueued'),
  downloaderTaskFailed: new Event<{ url: string, destination: string, progress: number, meta: any }>('downloaderTaskFailed'),
  downloaderTaskStatus: new Event<{url: string, destination: string, progress: number, meta: any}>('downloaderTaskStatus'),
  downloaderTaskCompleted: new Event<{ url: string, destination: string, progress: number, meta: any }>('downloaderTaskCompleted'),
  
  /* -------------------------------------------------------------------------- */
  /*                                  Playlist                                  */
  /* -------------------------------------------------------------------------- */

  playTrackRequested: new Event<{ playlistItemId: string }>('playTrackRequested'),
  playlistUpdateRequested: new Event<{ language: string }>('playlistUpdateRequested'),

  /* -------------------------------------------------------------------------- */
  /*                                    Notes                                   */
  /* -------------------------------------------------------------------------- */

  notesUpdateRequested: new Event<void>('notesUpdateRequested'),

  /* -------------------------------------------------------------------------- */
  /*                                Subscriptions                               */
  /* -------------------------------------------------------------------------- */

  restoreSubscriptionPlanRequested: new Event<void>('restoreSubscriptionPlanRequested'),

  /* -------------------------------------------------------------------------- */
  /*                               Authentication                               */
  /* -------------------------------------------------------------------------- */

  authenticationRequestedEvent: new Event<{ provider: string }>('authenticationRequestedEvent'),
  logOutRequestedEvent: new Event<void>('logOutRequestedEvent'),
}

export const Slots = {
  getDownloaderTasks: new Connection<Array<{ url: string, destination: string, progress: number, meta: any }>>(),
}