import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { appleSignIn, renderGoogleButton } from '../lib/socialSdks'

export interface WebSession {
  userId: string
  email: string | null
  name: string | null
  picture: string | null
  anonymous: boolean
  tier: string
  tierExpiresAt: number | null
  quotaId: string
}

export interface WebAuthConfig {
  authBase: string
  googleClientId?: string
  appleServicesId?: string
  appleRedirectUri?: string
  locale?: string
}

export interface WebAuth {
  session: Ref<WebSession | null>
  ready: Ref<boolean>
  signedIn: ComputedRef<boolean>
  isPro: ComputedRef<boolean>
  // ChatAuth-compatible surface consumed by useChatStream.
  getToken: () => string | null
  ensureToken: () => Promise<string>
  resetToken: () => void
  mountGoogleButton: (el: HTMLElement) => void
  signInApple: () => Promise<boolean>
  signOut: () => Promise<void>
}

interface StoredTokens {
  accessToken: string
  refreshToken: string
  userId: string
  email: string | null
  name: string | null
  picture: string | null
  anonymous: boolean
  accessTokenExpiresAt: number
  tier: string
  tierExpiresAt: number | null
  quotaId: string
}

interface TokenResponseBody {
  accessToken: string
  refreshToken: string
  userId: string
  anonymous: boolean
}

interface MeBody {
  userId: string
  email: string | null
  name: string | null
  pictureUrl: string | null
  anonymous: boolean
  tier?: string
  tierExpiresAt?: string | null
}

const STORAGE_KEY = 'lts_auth_tokens'
const DEVICE_KEY = 'lts_device_id'
const ANON_RETRY_BACKOFF_MS = [400, 1200, 3000]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const session = ref<WebSession | null>(null)
const ready = ref(false)

let cfg: WebAuthConfig | null = null
let stored: StoredTokens | null = null
let initialized = false
let refreshInFlight: Promise<string | null> | null = null
let bootstrapInFlight: Promise<string> | null = null

function deviceId(): string {
  let v = localStorage.getItem(DEVICE_KEY)
  if (!v) {
    v = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, v)
  }
  return v
}

function loadTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredTokens) : null
  } catch {
    return null
  }
}

function persistTokens(t: StoredTokens): void {
  stored = t
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
  } catch {
    /* private mode / quota — keep the in-memory copy */
  }
}

function clearTokens(): void {
  stored = null
  session.value = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

function decodeAccessClaims(accessToken: string): {
  expMs: number
  tier: string
  tierExpiresAtMs: number | null
  quotaId: string
} {
  try {
    const [, payloadB64] = accessToken.split('.')
    const json = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    const rawExp = typeof json.tier_expires_at === 'number' ? json.tier_expires_at : 0
    return {
      expMs: typeof json.exp === 'number' ? json.exp * 1000 : 0,
      tier: typeof json.tier === 'string' ? json.tier : 'free',
      tierExpiresAtMs: rawExp > 0 ? rawExp * 1000 : null,
      quotaId: typeof json.quota_id === 'string' ? json.quota_id : '',
    }
  } catch {
    return { expMs: 0, tier: 'free', tierExpiresAtMs: null, quotaId: '' }
  }
}

function sessionFromTokens(t: StoredTokens): WebSession {
  return {
    userId: t.userId,
    email: t.email,
    name: t.name,
    picture: t.picture,
    anonymous: t.anonymous,
    tier: t.tier || 'free',
    tierExpiresAt: t.tierExpiresAt ?? null,
    quotaId: t.quotaId ?? '',
  }
}

function authBase(): string {
  if (!cfg?.authBase) throw new Error('auth_unconfigured')
  return cfg.authBase
}

async function fetchMeBody(accessToken: string): Promise<MeBody | null> {
  try {
    const res = await fetch(`${authBase()}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return (await res.json()) as MeBody
  } catch {
    return null
  }
}

async function commitTokenResponse(body: TokenResponseBody): Promise<string> {
  const me = await fetchMeBody(body.accessToken)
  const claims = decodeAccessClaims(body.accessToken)
  let tierExpiresAt = claims.tierExpiresAtMs
  if (tierExpiresAt === null && me?.tierExpiresAt) {
    const parsed = Date.parse(me.tierExpiresAt)
    tierExpiresAt = Number.isFinite(parsed) ? parsed : null
  }
  const next: StoredTokens = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.userId,
    email: me?.email ?? null,
    name: me?.name ?? null,
    picture: me?.pictureUrl ?? null,
    anonymous: body.anonymous,
    accessTokenExpiresAt: claims.expMs,
    tier: claims.tier || me?.tier || 'free',
    tierExpiresAt,
    quotaId: claims.quotaId,
  }
  persistTokens(next)
  session.value = sessionFromTokens(next)
  return next.accessToken
}

async function callAnonymous(): Promise<TokenResponseBody> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
    },
    body: JSON.stringify({ deviceId: deviceId(), platform: 'web' }),
  }
  let lastErr: unknown
  for (let attempt = 0; attempt <= ANON_RETRY_BACKOFF_MS.length; attempt++) {
    let res: Response
    try {
      res = await fetch(`${authBase()}/auth/anonymous`, init)
    } catch (e) {
      lastErr = e
      if (attempt === ANON_RETRY_BACKOFF_MS.length) break
      await sleep(ANON_RETRY_BACKOFF_MS[attempt])
      continue
    }
    if (res.ok) return (await res.json()) as TokenResponseBody
    const transient = res.status === 429 || res.status === 408 || res.status >= 500
    if (!transient) throw new Error(`auth/anonymous: HTTP ${res.status}`)
    lastErr = new Error(`auth/anonymous: HTTP ${res.status}`)
    if (attempt === ANON_RETRY_BACKOFF_MS.length) break
    await sleep(ANON_RETRY_BACKOFF_MS[attempt])
  }
  throw lastErr ?? new Error('auth/anonymous: retries exhausted')
}

// The anonymous identity is the floor every visitor lands on; coalesce
// concurrent bootstraps behind one /auth/anonymous round-trip.
function bootstrapAnonymous(): Promise<string> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      try {
        return await commitTokenResponse(await callAnonymous())
      } finally {
        bootstrapInFlight = null
      }
    })()
  }
  return bootstrapInFlight
}

type RefreshOutcome = { ok: true; body: TokenResponseBody } | { ok: false; rejected: boolean }

async function callRefresh(refreshToken: string): Promise<RefreshOutcome> {
  let res: Response
  try {
    res = await fetch(`${authBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  } catch {
    return { ok: false, rejected: false }
  }
  if (res.ok) return { ok: true, body: (await res.json()) as TokenResponseBody }
  return { ok: false, rejected: res.status === 401 || res.status === 403 }
}

async function signinSocial(
  provider: 'google' | 'apple',
  idToken: string,
  fullName?: string,
): Promise<void> {
  const res = await fetch(`${authBase()}/auth/signin/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
    },
    body: JSON.stringify({ idToken, ...(fullName ? { fullName } : {}) }),
  })
  if (!res.ok) throw new Error(`auth/signin/${provider}: HTTP ${res.status}`)
  await commitTokenResponse((await res.json()) as TokenResponseBody)
}

function init(): void {
  if (initialized) return
  initialized = true
  stored = loadTokens()
  if (stored) session.value = sessionFromTokens(stored)
  ready.value = true
}

async function ensureToken(): Promise<string> {
  init()
  if (!stored) return bootstrapAnonymous()
  if (stored.accessTokenExpiresAt - Date.now() > 60_000) return stored.accessToken
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const r = await callRefresh(stored!.refreshToken)
        if (!r.ok) {
          if (r.rejected) clearTokens()
          return null
        }
        return await commitTokenResponse(r.body)
      } finally {
        refreshInFlight = null
      }
    })()
  }
  const tok = await refreshInFlight
  if (tok) return tok
  // Refresh was rejected (tokens cleared) or raced a clear — fall back to
  // the anonymous floor so chat keeps working, never strand token-less.
  if (stored?.accessToken) return stored.accessToken
  return bootstrapAnonymous()
}

export function useWebAuth(config?: WebAuthConfig): WebAuth {
  if (config && !cfg) cfg = config
  return {
    session,
    ready,
    signedIn: computed(() => !!session.value && !session.value.anonymous),
    isPro: computed(() => session.value?.tier === 'pro'),
    getToken: () => stored?.accessToken ?? null,
    ensureToken,
    // On a chat 401 we expire the cached access token so the next
    // ensureToken() rotates via /refresh (or re-bootstraps anon) instead of
    // wiping a signed-in session and silently dropping the user to free.
    resetToken: () => {
      if (stored) persistTokens({ ...stored, accessTokenExpiresAt: 0 })
    },
    mountGoogleButton: (el: HTMLElement) => {
      init()
      const clientId = cfg?.googleClientId
      if (!clientId) return
      renderGoogleButton(el, clientId, (idToken) => void signinSocial('google', idToken), {
        locale: cfg?.locale,
      })
    },
    signInApple: async () => {
      init()
      const servicesId = cfg?.appleServicesId
      const redirectUri = cfg?.appleRedirectUri
      if (!servicesId || !redirectUri) return false
      const r = await appleSignIn(servicesId, redirectUri)
      if (!r) return false
      await signinSocial('apple', r.idToken, r.fullName)
      return true
    },
    signOut: async () => {
      init()
      if (stored && !stored.anonymous) {
        try {
          await fetch(`${authBase()}/auth/signout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${stored.accessToken}`,
            },
            body: JSON.stringify({ refreshToken: stored.refreshToken }),
          })
        } catch {
          /* drop locally regardless */
        }
      }
      clearTokens()
      await bootstrapAnonymous()
    },
  }
}
