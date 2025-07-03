
import { SocialLogin } from '@capgo/capacitor-social-login'
import { useLogger } from '@lectorium/mobile/features/app.core'

/**
 * Initializes social authentication for the application.
 * 
 * @param options Configuration options for social authentication.
 * @param options.googleOAuthClientId The OAuth client ID for Google authentication.
 * @param options.appleOAuthClientId The OAuth client ID for Apple authentication.
 * 
 * @remarks
 * Using this module requires the `@capgo/capacitor-social-login` plugin to be installed and
 * configured. See the plugin documentation for more details (https://github.com/Cap-go/capacitor-social-login)
 */
export async function initSocialAuth(options: {
  googleOAuthClientId: string,
  appleOAuthClientId: string,
}) {
  const logger = useLogger({ module: 'app.auth' })

  logger.info('Initializing social authentication...')
  try {
    SocialLogin.initialize({
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