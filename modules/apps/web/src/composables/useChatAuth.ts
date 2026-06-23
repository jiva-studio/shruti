export interface ChatAuth {
  getToken: () => string | null
  ensureToken: () => Promise<string>
  resetToken: () => void
}

export function useChatAuth(authBase: string): ChatAuth {
  let token: string | null = null

  function deviceId(): string {
    const k = 'lts_device_id'
    let v = localStorage.getItem(k)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
    return v
  }

  async function ensureToken(): Promise<string> {
    if (token) return token
    const cached = sessionStorage.getItem('lts_chat_token')
    if (cached) { token = cached; return token }
    if (!authBase) throw new Error('auth_unconfigured')
    const r = await fetch(`${authBase}/auth/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), platform: 'web' }),
    })
    if (!r.ok) throw new Error('auth_failed')
    const j = await r.json()
    token = j.accessToken
    sessionStorage.setItem('lts_chat_token', token!)
    return token!
  }

  function resetToken(): void {
    token = null
    sessionStorage.removeItem('lts_chat_token')
  }

  return { getToken: () => token, ensureToken, resetToken }
}
