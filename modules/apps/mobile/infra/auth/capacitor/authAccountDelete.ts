import { AccountDeleteError, type AuthConfig } from "@ports/app/auth.js"
import { accountDeleteErrorFromStatus } from "./authErrors.js"

export interface AccountDeleteDeps {
  readonly request: AuthConfig["request"]
  readonly currentUserId: () => string | null
  readonly currentAccessToken: () => string | null
  readonly getAccessToken: () => Promise<string | null>
  readonly clearTokens: () => Promise<void>
}

/**
 * Delete the server account, clearing local tokens only once the server has
 * confirmed. The caller follows up with a local wipe, so clearing on a 5xx
 * would lose notes, chats and downloads while the account still exists.
 */
export function createDeleteAccount(deps: AccountDeleteDeps): () => Promise<void> {
  async function post(token: string): Promise<Response> {
    try {
      return await deps.request("/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      })
    } catch {
      throw new AccountDeleteError("network")
    }
  }

  /**
   * One refresh-and-retry for a stale access token. The identity is captured
   * beforehand: if the session was swapped in between (sign-out then
   * re-bootstrap, switch account), retrying would delete the wrong account.
   */
  async function retry(targetUserId: string): Promise<Response> {
    const refreshed = await deps.getAccessToken()
    if (!refreshed) throw new AccountDeleteError("unauthorized", 401)
    if (deps.currentUserId() !== targetUserId) throw new AccountDeleteError("unauthorized", 401)
    return post(refreshed)
  }

  return async () => {
    const token = deps.currentAccessToken()
    const targetUserId = deps.currentUserId()
    if (!token || targetUserId === null) return

    let res = await post(token)
    if (res.status === 401) res = await retry(targetUserId)
    if (res.ok) {
      await deps.clearTokens()
      return
    }
    // A 410 means the account is already gone, so drop local tokens too and
    // let the caller's wipe land on a clean anonymous slate.
    if (res.status === 410) await deps.clearTokens()
    throw accountDeleteErrorFromStatus(res.status)
  }
}
