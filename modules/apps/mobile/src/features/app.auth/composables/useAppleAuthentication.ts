import { SocialLogin } from '@capgo/capacitor-social-login'
import { AuthenticationResponse } from '../models/AuthenticationResponse'

/**
 * Authenticates user with Apple using the SocialLogin plugin.
 * @param options.authenticateUrl URL to authenticate user with the backend.
 * @returns AuthenticationResponse containing access token, refresh token, and user details.
 */
export function useAppleAuthentication(options: {
  authenticateUrl: string,
}) {

  async function authenticate(): Promise<AuthenticationResponse|null> {
    try {
      // Authenticate user with Apple using the SocialLogin plugin
      const res = await SocialLogin.login({
        provider: 'apple',
        options: {}
      })

      // Login/register user and get JWT tokens from backend
      const response = await fetch(
        options.authenticateUrl, 
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'apple',
            jwt: res.result.accessToken?.token,
          }),
        })

      // Check if the response is ok and tokens are received
      const tokens = await response.json()
      if (!tokens.accessToken || !tokens.refreshToken) {
        throw new Error('No access token received from server.')
      }

      // Update config with user data and tokens
      // TODO: apple provides givenName and family name only for the first time
      //       for the second time it will be empty. User have to delete the app,
      //       delete app-account in icloud get the names again. So we have to get
      //       the names from the another source in case they are missing.
      const { givenName, familyName, email } = res.result.profile

      // Return the authentication result
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userFirstName: givenName || '',
        userLastName: familyName || '',
        userEmail: email || '',
        avatarUrl: '' // Apple does not provide avatar URL, so we return an empty string
      }
    } catch (error: any) {
      // apple: user canceled the login. 1001 is the error code in the text
      if (error?.errorMessage?.includes('1001')) { return null }
      alert(`Authentication failed. Please try again. ${JSON.stringify(error)}`)
      throw error
    }
  }

  return {
    authenticate,
  }
}