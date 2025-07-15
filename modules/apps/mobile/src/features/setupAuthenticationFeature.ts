import { actionSheetController } from '@ionic/vue'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { Routes } from '@shruti/protocol/routes'
import { useDedupedCallFunction, useEventBus, useLogger } from '@shruti/mobile/core'
import { useAuthTokenRefresher, useUserAvatarDownloader, useAuth, AuthTokenRefreshError } from '@blocks/app.auth'
import { useUserInfo } from '@blocks/app.auth/composables/useUserInfo'
import { useConfig } from '@blocks/app.config'
import { useRemoteDatabase } from '@blocks/app.database'
import { useLocalization } from '@blocks/app.localization'
import { ENVIRONMENT } from '../env'
import { Capacitor } from '@capacitor/core'
import { useBucketService } from '@blocks/app.services.bucket'

export async function setupAuthenticationFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const i18n = useLocalization()
  const auth = useAuth()
  const config = useConfig()
  const logger = useLogger({ module: 'app.auth' })
  const userInfo = useUserInfo()
  const eventBus = useEventBus()
  const bucketService = useBucketService()
  const remoteDatabase = useRemoteDatabase()
  const authTokenRefresher = useAuthTokenRefresher()
  const userAvatarDownloader = useUserAvatarDownloader()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSelectProvider.subscribe(async () => {
    // On android there is only Google sign-in available, so where is no
    // need to show action sheet with only one option.
    // TODO: remove it once additional providers will be available on Android.
    if (Capacitor.getPlatform() === 'android') {
      eventBus.authSignIn.notify({ provider: 'google' })
      return
    }
    
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

  eventBus.authSelectAuthenticatedActions.subscribe(async () => {
    const { t } = i18n.global 
    const logoutAction = { text: t('settings.auth.signOut'), data: { action: 'logout' } }
    const cancelAction = { text: t('app.cancel'),  role: 'cancel', data: { action: 'cancel' } }

    const actionSheet = await actionSheetController.create({
      header: t('settings.auth.actions'),
      buttons: [logoutAction, cancelAction]
    })

    await actionSheet.present()
    actionSheet.onDidDismiss().then((result) => {
      if (result.role === 'cancel' || !result.data?.action) { return }
      if (result.data.action === 'logout') { eventBus.authSignOut.notify() }
    })
  })

  /**
   * Saves user authentication data to the configuration.
   */
  eventBus.authSignIn.subscribe(async (event) => {
    const result = await auth.signIn(event.provider)
    if (!result) { return }

    config.userName.value = `${result.userFirstName} ${result.userLastName}`.trim()
    config.userEmail.value = result.userEmail

    await eventBus.authCredentialsReceived.notify({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })

    eventBus.userInfoSave.notify({
      firstName: result.userFirstName,
      lastName: result.userLastName,
      email: result.userEmail,
      avatarUrl: result.avatarUrl || undefined
    })
    eventBus.sync.notify()
    eventBus.subscriptionLoad.notify()
    if (result.avatarUrl) {
      eventBus.userInfoDownloadAvatar.notify({ avatarUrl: result.avatarUrl })
    }
    eventBus.authSignInEnd.notify({ userEmail: result.userEmail })
  })

  /**
   * Download user avatar if available and save it to the configuration.
   */
  eventBus.userInfoDownloadAvatar.subscribe(async (event) => {
    if (event.avatarUrl) {
      const avatar = await userAvatarDownloader.download(event.avatarUrl)
      config.userAvatarUrl.value = avatar || ''
    }
  })

  /**
   * Save user information to the database.
   */
  eventBus.userInfoSave.subscribe(async (event) => {
    await userInfo.save({
      firstName: event.firstName,
      lastName: event.lastName,
      email: event.email,
      avatarUrl: event.avatarUrl || undefined,
    })
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Sign Out                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Sign out user and reset authentication data.
   */
  eventBus.authSignOut.subscribe(async () => {
    config.authToken.value = ENVIRONMENT.readonlyAuthToken
    config.refreshToken.value = ''
    config.userName.value = ''
    config.userEmail.value = ''
    config.userAvatarUrl.value = ''
    config.subscriptionPlan.value = ''
    config.authTokenExpiresAt.value = 0

    bucketService.setAuthToken(ENVIRONMENT.readonlyAuthToken)
    remoteDatabase.init({
      url: config.databaseUrl.value,
      userId: config.userEmail.value,
      authToken: ENVIRONMENT.readonlyAuthToken,
    })
  })

  eventBus.authSignOut.subscribe(async () => {
    await Purchases.logOut()
  })

  /* -------------------------------------------------------------------------- */
  /*                   Authentication Token : Refresh Request                   */
  /* -------------------------------------------------------------------------- */

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
          alert(error.message)
          await eventBus.authSignOut.notify()
        } else {
          logger.error(`Failed to refresh authentication token`, error)
        }
      } 
    })
  )

  /* -------------------------------------------------------------------------- */
  /*                       Authentication Token : Received                      */
  /* -------------------------------------------------------------------------- */

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
      userId: config.userEmail.value,
      authToken: event.accessToken,
    })
  })

  /* -------------------------------------------------------------------------- */
  /*                           User Info : Load Request                         */
  /* -------------------------------------------------------------------------- */

  eventBus.userInfoLoad.subscribe(async () => {
    const result = await userInfo.load()
    if (result && (result.firstName || result.lastName)) {
      config.userName.value = `${result.firstName} ${result.lastName}`.trim()
    }
    if (result?.avatarUrl) {
      const avatar = await userAvatarDownloader.download(result.avatarUrl)
      config.userAvatarUrl.value = avatar || ''
    }
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