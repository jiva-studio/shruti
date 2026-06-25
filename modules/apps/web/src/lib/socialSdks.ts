// Browser loaders for Google Identity Services and Sign in with Apple JS.
// Both yield an ID token that the auth backend verifies via JWKS — the exact
// same `/auth/signin/{google,apple}` contract the native app uses.

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const APPLE_SRC =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'

const scriptCache = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  let p = scriptCache.get(src)
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script')
      el.src = src
      el.async = true
      el.onload = () => resolve()
      el.onerror = () => reject(new Error(`load failed: ${src}`))
      document.head.appendChild(el)
    })
    scriptCache.set(src, p)
  }
  return p
}

interface GoogleCredentialResponse {
  credential?: string
}

interface GoogleAccountsId {
  initialize: (opts: {
    client_id: string
    callback: (resp: GoogleCredentialResponse) => void
    ux_mode?: 'popup' | 'redirect'
  }) => void
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void
}

function gis(): GoogleAccountsId | null {
  const g = (window as unknown as { google?: { accounts?: { id?: GoogleAccountsId } } }).google
  return g?.accounts?.id ?? null
}

export async function renderGoogleButton(
  el: HTMLElement,
  clientId: string,
  onCredential: (idToken: string) => void,
  opts?: { locale?: string },
): Promise<void> {
  await loadScript(GIS_SRC)
  const id = gis()
  if (!id) return
  id.initialize({
    client_id: clientId,
    ux_mode: 'popup',
    callback: (resp) => {
      if (resp.credential) onCredential(resp.credential)
    },
  })
  id.renderButton(el, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    logo_alignment: 'center',
    locale: opts?.locale,
    width: Math.min(el.clientWidth || 280, 360),
  })
}

interface AppleAuth {
  init: (opts: {
    clientId: string
    scope: string
    redirectURI: string
    usePopup: boolean
  }) => void
  signIn: () => Promise<{
    authorization?: { id_token?: string }
    user?: { name?: { firstName?: string; lastName?: string } }
  }>
}

function appleId(): AppleAuth | null {
  const a = (window as unknown as { AppleID?: { auth?: AppleAuth } }).AppleID
  return a?.auth ?? null
}

export async function appleSignIn(
  servicesId: string,
  redirectUri: string,
): Promise<{ idToken: string; fullName?: string } | null> {
  await loadScript(APPLE_SRC)
  const auth = appleId()
  if (!auth) return null
  auth.init({ clientId: servicesId, scope: 'name email', redirectURI: redirectUri, usePopup: true })
  try {
    const resp = await auth.signIn()
    const idToken = resp?.authorization?.id_token
    if (!idToken) return null
    const name = resp?.user?.name
    const fullName = name
      ? [name.firstName, name.lastName].filter(Boolean).join(' ').trim() || undefined
      : undefined
    return { idToken, fullName }
  } catch {
    // Popup closed / cancelled / blocked — treat as no-op.
    return null
  }
}
