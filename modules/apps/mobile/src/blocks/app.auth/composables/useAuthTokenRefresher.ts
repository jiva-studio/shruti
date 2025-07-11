import { Routes } from '@shruti/protocol/routes'
import { createSharedComposable } from '@vueuse/core'

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
      let accessTokenExpiresAt: number | null = null
      const tokens = await response.json()
      
      if (tokens.accessToken) {
        const parts = tokens.accessToken.split('.')
        const payload = JSON.parse(atob(parts[1]))
        accessTokenExpiresAt = payload.exp * 1000
      }

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt,
      } as {
        accessToken: string,
        refreshToken: string,
        accessTokenExpiresAt: number
      }
    } else {
      return null
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, refresh }
})