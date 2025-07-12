import { Event } from './Event'
import { createSharedComposable } from '@vueuse/core'

export const useEventBus = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                     App                                    */
  /* -------------------------------------------------------------------------- */

  const appReady = new Event<void>('appReady')

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
  const syncEnd = new Event<void>('syncEnd')

  /* -------------------------------------------------------------------------- */
  /*                                    Notes                                   */
  /* -------------------------------------------------------------------------- */

  const notesAdd = new Event<{ trackId: string, text: string, blocks: string[] }>('notesAdd')
  const notesLoad = new Event<void>('notesLoad')

  /* -------------------------------------------------------------------------- */
  /*                                   Tracks                                   */
  /* -------------------------------------------------------------------------- */

  const trackPlay      = new Event<{ playlistItemId: string }>('trackPlay')
  const trackDownload  = new Event<{ trackId: string[] }>('trackDownload')
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
  const playlistArchive = new Event<void>('playlistArchive')

  /* -------------------------------------------------------------------------- */
  /*                                Subscription                                */
  /* -------------------------------------------------------------------------- */

  const subscriptionLoad = new Event<void>('subscriptionLoad')


  /* -------------------------------------------------------------------------- */
  /*                                Authentcation                               */
  /* -------------------------------------------------------------------------- */

  const authSignIn = new Event<{ provider: 'google' | 'apple' }>('authSignIn')
  const authSignOut = new Event<void>('authSignOut')
  const authTokenRefresh = new Event<void>('authTokenRefresh')
  const authSelectProvider = new Event<void>('authSelectProvider')
  const authSelectAuthenticatedActions = new Event<void>('authSelectAuthenticatedActions')

  /* -------------------------------------------------------------------------- */
  /*                                  Tutorial                                  */
  /* -------------------------------------------------------------------------- */

  const tutorialCompleteStep = new Event<{ step: string }>('tutorialCompleteStep')

  /* -------------------------------------------------------------------------- */
  /*                                 Dictionary                                 */
  /* -------------------------------------------------------------------------- */

  const dictionaryLoad = new Event<void>('dictionaryLoad')

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { 
    // app
    appReady,
    
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
    playlistArchive,

    // subscription
    subscriptionLoad,

    // authentication
    authSignIn,
    authSignOut,
    authTokenRefresh,
    authSelectProvider,
    authSelectAuthenticatedActions,

    // tutorial
    tutorialCompleteStep,

    // dictionary
    dictionaryLoad
  }
})