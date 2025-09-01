import { useDedupedCallFunction, useEventBus, useLogger } from '@shruti/mobile/core'
import { useAuthTokenRefresher, AuthTokenRefreshError } from '@blocks/app.auth'

export async function featureRefreshToken() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'featureRefreshToken' })
  const eventBus = useEventBus()
  const authTokenRefresher = useAuthTokenRefresher()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
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
        await eventBus.authTokenRefreshed.notify({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        })
      } catch (error: any) {
        if (
          error instanceof AuthTokenRefreshError && 
          (error.status === 401 || error.status === 403)
        ) {
          // If the error is related to token refresh, we need to sign out user.
          logger.error(error.message, error)
          await eventBus.authSignOut.notify()
        } else {
          logger.error(`Failed to refresh authentication token`, error)
        }
      } 
    })
  )

}