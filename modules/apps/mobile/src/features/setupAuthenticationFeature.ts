import { Filesystem, Directory } from '@capacitor/filesystem'
import { modalController } from '@ionic/vue'
import { actionSheetController } from '@ionic/vue'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { Capacitor } from '@capacitor/core'
import { Routes } from '@lectorium/protocol/routes'
import { useDedupedCallFunction, useEventBus, useLogger } from '@lectorium/mobile/core'
import { useAuthTokenRefresher, useUserAvatarDownloader, useAuth, AuthTokenRefreshError, DeleteAccountDialog } from '@blocks/app.auth'
import { useConfig } from '@blocks/app.config'
import { useLocalDatabase, useRemoteDatabase } from '@blocks/app.database'
import { useLocalization } from '@blocks/app.localization'
import { useBucketService } from '@blocks/app.services.bucket'
import { ENVIRONMENT } from '../env'
import { useTracksStateStore } from '@blocks/app.tracks.state'

export async function setupAuthenticationFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const i18n = useLocalization()
  const auth = useAuth()
  const config = useConfig()
  const logger = useLogger({ module: 'app.auth' })
  const eventBus = useEventBus()
  const bucketService = useBucketService()
  const remoteDatabase = useRemoteDatabase()
  const authTokenRefresher = useAuthTokenRefresher()
  const userAvatarDownloader = useUserAvatarDownloader()
  const localDatabase = useLocalDatabase()
  const tracksStateStore = useTracksStateStore()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  /* ------------------------- Authentication Actions ------------------------- */

  // User can select multiple authentication providers to sign in. It shows an 
  // action sheet with available options. If user selects an option, it will
  // trigger the `authSignIn` event with the selected provider.
  eventBus.authSelectProvider.subscribe(async () => {
    // On android there is only Google sign-in available, so where is no
    // need to show action sheet with only one option.
    // TODO: remove it once additional providers will be available on Android.
    if (Capacitor.getPlatform() === 'android') {
      eventBus.authSignIn.notify({ provider: 'google' })
      return
    }
    
    // Action Sheet buttons with available authentication providers.
    const { t } = i18n.global 
    const googleAction = { text: 'Google',  data: { action: 'google' } }
    const appleAction  = { text: 'Apple',   data: { action: 'apple' } }
    const cancelAction = { text: t('app.cancel'),  role: 'cancel', data: { action: 'cancel' } }

    const actionSheetButtons = 
      Capacitor.getPlatform() === 'ios'     ? [appleAction, googleAction, cancelAction] :
      Capacitor.getPlatform() === 'android' ? [googleAction, cancelAction] : []

    const actionSheet = await actionSheetController.create({
      header: t('settings.auth.signIn.subtitle'),
      buttons: actionSheetButtons,
    })

    await actionSheet.present()
    actionSheet.onDidDismiss().then((result) => {
      if (result.role === 'cancel' || !result.data?.action) { return }
      eventBus.authSignIn.notify({ provider: result.data.action })
    })
  })

  /* ----------------------- Authenticated User Actions ----------------------- */

  eventBus.authSelectAuthenticatedActions.subscribe(async () => {
    const { t } = i18n.global 
    const logoutAction = { text: t('settings.auth.signOut'), data: { action: 'logout' } }
    const deleteAction = { text: t('settings.auth.delete'), data: { action: 'delete' } }
    const cancelAction = { text: t('app.cancel'),  role: 'cancel', data: { action: 'cancel' } }

    const actionSheet = await actionSheetController.create({
      header: t('settings.auth.actions'),
      buttons: [logoutAction, deleteAction, cancelAction]
    })

    await actionSheet.present()
    actionSheet.onDidDismiss().then((result) => {
      if (result.role === 'cancel' || !result.data?.action) { return }
      if (result.data.action === 'delete') { eventBus.authDeleteAccount.notify() }
      if (result.data.action === 'logout') { eventBus.authSignOut.notify() }
    })
  })

  /* --------------------------------- Sign In -------------------------------- */

  eventBus.authSignIn.subscribe(async (event) => {
    const result = await auth.signIn(event.provider)
    if (!result) { return }

    config.userName.value = `${result.userFirstName} ${result.userLastName}`.trim()
    config.userId.value = result.userId

    await eventBus.authCredentialsReceived.notify({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })

    // eventBus.userInfoSave.notify({
    //   firstName: result.userFirstName,
    //   lastName: result.userLastName,
    //   email: result.userEmail,
    //   avatarUrl: result.avatarUrl || undefined
    // })
    eventBus.sync.notify()
    eventBus.subscriptionLoad.notify()
    if (result.userImageUrl) {
      eventBus.userInfoDownloadAvatar.notify({ avatarUrl: result.userImageUrl })
    }
    eventBus.authSignInEnd.notify({ userId: result.userId })
  })

  /* ----------------------------- Delete Account ----------------------------- */

  eventBus.authDeleteAccount.subscribe(async () => {
    // Show confirmation dialog before deleting the account.
    const modal = await modalController.create({ component: DeleteAccountDialog })
    await modal.present()
    const { data, role } = await modal.onWillDismiss()
    if (role !== 'confirm') { return }
    
    // Delete user account from the server.
    const response = await fetch(
      Routes(config.apiUrl.value).account.delete(), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.authToken.value}`,
          'Content-Type': 'application/json',
        },
      }
    )

    // Check if account deletion was successful.
    const json = await response.json()
    if (!response.ok) {
      logger.error('Failed to delete account', json)
      alert(i18n.global.t('settings.auth.deleteAccount.error'))
      return
    }

    // Account was deleted successfully. Sign user out locally.
    logger.info('User\'s account was deleted successfully')
    alert(i18n.global.t('settings.auth.deleteAccount.deleted'))
    eventBus.authSignOut.notify()

    // Clear user data from the local database if requested.
    if (!data.keepMyProgress) {
      await localDatabase.destroyUserData()
      eventBus.notesLoad.notify()
      eventBus.playlistLoad.notify()
      tracksStateStore.clear()
      
      // Delete files
      try {
        Filesystem.rmdir({
          path: 'library/tracks',
          directory: Directory.External,
          recursive: true,
        })
      } catch (error: any) {
        // pass
      }
    }
  })

  /* -------------------------------- User Info ------------------------------- */

  eventBus.userInfoDownloadAvatar.subscribe(async (event) => {
    if (event.avatarUrl) {
      const avatar = await userAvatarDownloader.download(event.avatarUrl)
      config.userAvatarUrl.value = avatar || ''
    }
  })

  // eventBus.userInfoLoad.subscribe(async () => {
  //   const result = await userInfo.load()
  //   if (result && (result.firstName || result.lastName)) {
  //     config.userName.value = `${result.firstName} ${result.lastName}`.trim()
  //   }
  //   if (result?.avatarUrl) {
  //     const avatar = await userAvatarDownloader.download(result.avatarUrl)
  //     config.userAvatarUrl.value = avatar || ''
  //   }
  // })

  // eventBus.userInfoSave.subscribe(async (event) => {
  //   await userInfo.save({
  //     firstName: event.firstName,
  //     lastName: event.lastName,
  //     email: event.email,
  //     avatarUrl: event.avatarUrl || undefined,
  //   })
  // })

  /* -------------------------------- Sign Out -------------------------------- */

  eventBus.authSignOut.subscribe(async () => {
    config.authToken.value = ENVIRONMENT.readonlyAuthToken
    config.refreshToken.value = ''
    config.userName.value = ''
    config.userId.value = ''
    config.userAvatarUrl.value = ''
    config.subscriptionPlan.value = ''
    config.authTokenExpiresAt.value = 0

    bucketService.setAuthToken(ENVIRONMENT.readonlyAuthToken)
    remoteDatabase.init({
      url: config.databaseUrl.value,
      userId: config.userId.value,
      authToken: ENVIRONMENT.readonlyAuthToken,
    })
  })

  eventBus.authSignOut.subscribe(async () => {
    await Purchases.logOut()
  })

  /* -------------------------- Auth Token : Refresh -------------------------- */

  eventBus.authTokenRefresh.subscribe(
    // Deduped function to prevent multiple refresh requests with the same token.
    // Refreshed token will be marked as used (revoked) after successful refresh, 
    // so consecutive calls with the same token will lead to Unauthorized error.
    // In order to prevent multiple refresh requests with the same token, we use
    // a deduped call function here.
    useDedupedCallFunction(async ({ refreshToken }) => {
      try {
        const result = await authTokenRefresher.refresh(refreshToken)
        await eventBus.authCredentialsReceived.notify({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        })
      } catch (error: unknown) {
        if (
          error instanceof AuthTokenRefreshError && 
          (error.status === 401 || error.status === 403)
        ) {
          // If the error is related to token refresh, we need to sign out user.
          logger.error(error.message)
          await eventBus.authSignOut.notify()
        } else {
          logger.error(`Failed to refresh authentication token`, error)
        }
      } 
    })
  )

  /* -------------------------- Auth Token : Refresh -------------------------- */

  // Authentication and refresh token received from the server. It may
  // happen after successful sign-in or after token refresh.
  eventBus.authCredentialsReceived.subscribe(async (event) => {
    config.authToken.value = event.accessToken
    config.refreshToken.value = event.refreshToken

    const parts = event.accessToken.split('.')
    const payload = JSON.parse(atob(parts[1]))
    if (payload.exp) { 
      config.authTokenExpiresAt.value = payload.exp * 1000 
    }
    bucketService.setAuthToken(event.accessToken)
    remoteDatabase.init({
      url: config.databaseUrl.value,
      userId: config.userId.value,
      authToken: event.accessToken,
    })
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Setup                                   */
  /* -------------------------------------------------------------------------- */

  await useAuth().init({
    authenticateUrl: Routes(config.apiUrl.value).auth.signIn('jwt'),
    googleOAuthClientId: ENVIRONMENT.googleWebClientId,
    appleOAuthClientId: ENVIRONMENT.iOSClientId,
  })
}