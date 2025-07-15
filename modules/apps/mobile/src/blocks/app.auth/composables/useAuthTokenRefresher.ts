import { Routes } from '@shruti/protocol/routes'
import { createSharedComposable } from '@vueuse/core'

export class AuthTokenRefreshError extends Error {
  constructor(
    message: string, 
    public readonly status?: number
  ) {
    super(message)
    this.name = 'AuthTokenRefreshError'
  }
}

export type Options = {
  apiUrl: string
}

export const useAuthTokenRefresher = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  let options: Options | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init(o: Options) {
    options = o
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  async function refresh(refreshToken: string) {
    if (!options) { throw new Error('useAuthTokenRefresher is not initialized. Call init(options) first.') }
    
    const response = await fetch(
      Routes(options.apiUrl).auth.tokens.refresh(), 
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken: refreshToken
        }),
      })

    if (response.ok) {
      const tokens = await response.json()
      return {
        accessToken: tokens.accessToken as string,
        refreshToken: tokens.refreshToken as string,
      }
    } else if (response.status === 401 || response.status === 403) {
      throw new AuthTokenRefreshError(
        `Unable to refresh token: access denied`, 
        response.status)
    } else {
      throw new AuthTokenRefreshError(
        `Unable to refresh token: ${response.statusText}`, 
        response.status)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, refresh }
})