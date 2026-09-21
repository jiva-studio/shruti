import { Preferences } from "@capacitor/preferences"
import type { AuthConfig, AuthSession } from "@ports/app/auth.js"

import { fetchMeBody } from "./authHttp.js"
import {
  decodeAccessClaims,
  mergeStoredTokens,
  sessionFromTokens,
  type StoredTokens,
  type TokenResponseBody,
} from "./authTokens.js"

const PREFERENCES_KEY = "auth.tokens"

export interface AuthSessionStore {
  /** The session as the app currently sees it, or null when signed out. */
  current: () => AuthSession | null
  tokens: () => StoredTokens | null
  /** Restore the persisted tokens and expose them as the session, optimistically:
   *  a refresh is lazy and happens on the next token read. */
  restore: () => Promise<AuthSession | null>
  /** Persist a fresh token pair and publish the session it describes. */
  commit: (body: TokenResponseBody) => Promise<AuthSession>
  clear: () => Promise<void>
  onChange: (listener: (s: AuthSession | null) => void) => () => void
}

export function createAuthSessionStore(request: AuthConfig["request"]): AuthSessionStore {
  let session: AuthSession | null = null
  let stored: StoredTokens | null = null
  const listeners = new Set<(s: AuthSession | null) => void>()

  function publish(s: AuthSession | null): void {
    session = s
    for (const l of listeners) l(s)
  }

  return {
    current: () => session,
    tokens: () => stored,

    async restore(): Promise<AuthSession | null> {
      const { value } = await Preferences.get({ key: PREFERENCES_KEY })
      try {
        stored = value ? (JSON.parse(value) as StoredTokens) : null
      } catch {
        stored = null
      }
      if (!stored) return null
      const sess = sessionFromTokens(stored)
      publish(sess)
      return sess
    },

    async commit(body: TokenResponseBody): Promise<AuthSession> {
      const me = await fetchMeBody(request, body.accessToken)
      // Carry the stored identity forward only for the same user: a sign-in
      // that swaps accounts must not inherit the previous one's name or avatar.
      const prior = stored?.userId === body.userId ? stored : null
      stored = mergeStoredTokens(body, me, decodeAccessClaims(body.accessToken), prior)
      await Preferences.set({ key: PREFERENCES_KEY, value: JSON.stringify(stored) })
      const sess = sessionFromTokens(stored)
      publish(sess)
      return sess
    },

    async clear(): Promise<void> {
      stored = null
      publish(null)
      await Preferences.remove({ key: PREFERENCES_KEY })
    },

    onChange(listener: (s: AuthSession | null) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
