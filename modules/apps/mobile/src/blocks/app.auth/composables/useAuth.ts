import { useLogger } from '@lectorium/mobile/core'
import { SocialLogin } from '@capgo/capacitor-social-login'
import { AuthenticationResponse } from '../models/AuthenticationResponse'
import { useGoogleAuthentication } from './useGoogleAuthentication'
import { useAppleAuthentication } from './useAppleAuthentication'
import { InitOptions } from '../models/InitOptions'
import { createSharedComposable } from '@vueuse/core'

export const useAuth = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: InitOptions | null = null

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.auth' })

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init(o: InitOptions) {
    logger.info('Initializing social authentication...')
    options = o
    try {
      await SocialLogin.initialize({
        google: {
          webClientId: options.googleOAuthClientId,
          iOSClientId: options.appleOAuthClientId,
        },
        // NOTE: using apple defaults. adding that line back breaks 
        //       google (sic!) authentication. It looks like a bug in the
        //       @capgo/capacitor-social-login plugin. 
        // apple: {},
      })
      logger.info('Social authentication initialized successfully.')
    } catch (e: any) {
      logger.error(`Unable to initialize social auth: ${e.message || e}`)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Signals                                  */
  /* -------------------------------------------------------------------------- */

  async function signIn(provider: 'google' | 'apple') {
    if (options === null) {
      throw new Error('Authentication options are not initialized. Call init() first.')
    }
    let results: AuthenticationResponse | null = null
    if (provider === 'google') {
      results = await useGoogleAuthentication({ 
        authenticateUrl: options.authenticateUrl 
      }).authenticate()
    } else if (provider === 'apple') {
      results = await useAppleAuthentication({ 
        authenticateUrl: options.authenticateUrl
      }).authenticate()
    }
    // user canceled the login, internet connection issues,
    // or other unknown error.
    if (results === null) { return } 

    return {
      accessToken: results.accessToken,
      refreshToken: results.refreshToken,
      userFirstName: results.userFirstName,
      userLastName: results.userLastName,
      userEmail: results.userEmail,
      avatarUrl: results.avatarUrl,
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    init,
    signIn,
  }
})