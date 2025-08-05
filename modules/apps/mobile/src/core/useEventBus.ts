import { SyncResult } from '@lectorium/dal/persistence'
import { Event } from './Event'
import { createSharedComposable } from '@vueuse/core'

export const useEventBus = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                     App                                    */
  /* -------------------------------------------------------------------------- */

  const appReady = new Event<void>('appReady')
  const appStatusCheck = new Event<void>('appStatusCheck')

  /* -------------------------------------------------------------------------- */
  /*                                   Toasts                                   */
  /* -------------------------------------------------------------------------- */

  const toastShow = new Event<{ 
    header?: string, 
    duration?: number 
    color?: string,
    message: string, 
  }>('toastShow')

  /* -------------------------------------------------------------------------- */
  /*                                    User                                    */
  /* -------------------------------------------------------------------------- */

  const userInfoLoad = new Event<void>('userInfoLoad')
  const userInfoSave = new Event<{ firstName?: string, lastName?: string, email?: string, avatarUrl?: string }>('userInfoSave')
  const userInfoDownloadAvatar = new Event<{ avatarUrl: string }>('userInfoDownloadAvatar')

  /* -------------------------------------------------------------------------- */
  /*                                    Sync                                    */
  /* -------------------------------------------------------------------------- */

  const sync = new Event<void>('sync')
  const syncEnd = new Event<{ commonData: SyncResult, userData: SyncResult }>('syncEnd')

  /* -------------------------------------------------------------------------- */
  /*                                    Notes                                   */
  /* -------------------------------------------------------------------------- */

  const notesAdd = new Event<{ trackId: string, text: string, timeStart: number, timeEnd: number }>('notesAdd')
  const notesLoad = new Event<void>('notesLoad')
  const notesDelete = new Event<{ noteId: string }>('notesDelete')

  /* -------------------------------------------------------------------------- */
  /*                                   Tracks                                   */
  /* -------------------------------------------------------------------------- */

  const trackPlay      = new Event<{ playlistItemId: string }>('trackPlay')
  const trackDownload  = new Event<{ trackIds: string[], skipFailed: boolean, showError: boolean }>('trackDownload')
  const trackStateLoad = new Event<string[]>('trackStateLoad')

  /* -------------------------------------------------------------------------- */
  /*                                 Transcript                                 */
  /* -------------------------------------------------------------------------- */

  const transcriptLoad = new Event<{ trackId: string }>('transcriptLoad')

  /* -------------------------------------------------------------------------- */
  /*                                   Player                                   */
  /* -------------------------------------------------------------------------- */

  const playerSeek        = new Event<number>('playerSeek')
  const playerTogglePause = new Event<void>('playerTogglePause')

  /* -------------------------------------------------------------------------- */
  /*                                  Playlist                                  */
  /* -------------------------------------------------------------------------- */

  const playlistLoad = new Event<void>('playlistLoad')
  const playlistLoadEnd = new Event<void>('playlistLoadEnd')
  const playlistArchiveItem = new Event<{ playlistItemId: string }>('playlistArchiveItem')
  const playlistArchiveCompleted = new Event<void>('playlistArchiveCompleted')

  /* -------------------------------------------------------------------------- */
  /*                                Subscription                                */
  /* -------------------------------------------------------------------------- */

  const subscriptionLoad = new Event<void>('subscriptionLoad')


  /* -------------------------------------------------------------------------- */
  /*                                Authentcation                               */
  /* -------------------------------------------------------------------------- */

  const authSignIn = new Event<{ provider: 'google' | 'apple' }>('authSignIn')
  const authSignOut = new Event<void>('authSignOut')
  const authSignInEnd = new Event<{ userId: string }>('authSignInEnd')
  const authTokenRefresh = new Event<{ refreshToken: string }>('authTokenRefresh')
  const authCredentialsReceived = new Event<{ accessToken: string, refreshToken: string }>('authCredentialsReceived')
  const authSelectProvider = new Event<void>('authSelectProvider')
  const authSelectAuthenticatedActions = new Event<void>('authSelectAuthenticatedActions')
  const authDeleteAccount = new Event<void>('authDeleteAccount')

  /* -------------------------------------------------------------------------- */
  /*                                  Tutorial                                  */
  /* -------------------------------------------------------------------------- */

  const tutorialCompleteStep = new Event<{ step: string }>('tutorialCompleteStep')

  /* -------------------------------------------------------------------------- */
  /*                                 Dictionary                                 */
  /* -------------------------------------------------------------------------- */

  const dictionaryLoad = new Event<void>('dictionaryLoad')

  /* -------------------------------------------------------------------------- */
  /*                                    Share                                   */
  /* -------------------------------------------------------------------------- */

  const shareSendTrackExcerpt = new Event<{ 
    trackId: string, 
    text?: string, 
    timeStart?: number, 
    timeEnd?: number,
    shareAudio?: boolean,
  }>('shareTrackExcerpt')

  const shareCopyTrackExcerpt = new Event<{ 
    trackId: string, 
    text: string, 
    // timeStart?: number, 
    // timeEnd?: number,
  }>('shareTrackExcerpt')

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    // app
    appReady,
    appStatusCheck,
    
    // toasts
    toastShow,

    // user
    userInfoLoad,
    userInfoSave,
    userInfoDownloadAvatar,

    // sync
    sync,
    syncEnd,

    // notes
    notesAdd,
    notesLoad,
    notesDelete,
    
    // tracks
    trackDownload,
    trackPlay,
    trackStateLoad,

    // player
    playerSeek,
    playerTogglePause,

    // transcript
    transcriptLoad,

    // playlist
    playlistLoad,
    playlistLoadEnd,
    playlistArchiveItem,
    playlistArchiveCompleted,

    // subscription
    subscriptionLoad,

    // authentication
    authSignIn,
    authSignOut,
    authSignInEnd,
    authTokenRefresh,
    authSelectProvider,
    authCredentialsReceived,
    authSelectAuthenticatedActions,
    authDeleteAccount,

    // tutorial
    tutorialCompleteStep,

    // dictionary
    dictionaryLoad,


    // share
    shareSendTrackExcerpt,
    shareCopyTrackExcerpt,
  }
})