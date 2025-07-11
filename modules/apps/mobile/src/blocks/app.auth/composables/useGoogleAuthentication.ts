import { SocialLogin } from '@capgo/capacitor-social-login'
import { AuthenticationResponse } from '../models/AuthenticationResponse'

/**
 * Authenticates user with Google and retrieves JWT tokens from the backend.
 * @param options.authenticateUrl URL to authenticate user with the backend.
 * @returns AuthenticationResponse containing access token, refresh token, and user details.
 */
export function useGoogleAuthentication(options: {
  authenticateUrl: string,
}) {

  async function authenticate(): Promise<AuthenticationResponse|null> {
    try {
      const res = await SocialLogin.login({
        provider: 'google',
        options: {}
      })

      // Validate response from Google
      if (res.provider !== 'google' || res.result.responseType !== 'online') {
        throw new Error('Invalid response from Google login.')
      }

      // Login/register user and get JWT tokens from backend
      const response = await fetch(
        options.authenticateUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'google',
            jwt: res.result.idToken,
          }),
        })
        
      // Check if the response is ok and tokens are received
      const tokens = await response.json()
      if (!tokens.accessToken || !tokens.refreshToken) {
        throw new Error('No access token received from server.')
      }

      // Update config with user data and tokens
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userFirstName: res.result.profile.givenName || '',
        userLastName: res.result.profile.familyName || '',
        userEmail: res.result.profile.email || '',
        avatarUrl: res.result.profile.imageUrl,
      }
    } catch (error: any) {
      // google: user canceled the login.
      // NOTE: looks like @capgo/capacitor-social-login has a bug, because
      //       cancellation code is 16, and you can see it in the logs. But it returns
      //       nothing to define the reason of the error. Asume this will work.
      if (!error?.code) { return null }
      alert(`Authentication failed. Please try again. ${JSON.stringify(error)}`)
      throw error
    }
  }

  return {
    authenticate,
  }
}