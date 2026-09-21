import type { AuthConfig } from "@ports/app/auth.js"
import type { MeBody, TokenResponseBody } from "./authTokens.js"

type RequestFn = AuthConfig["request"]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Backoff for the anonymous-bootstrap retry. That endpoint is the app's
 * identity floor — a failure leaves the user with no token at all — so a
 * transient failure is retried rather than stranding the app until the next
 * manual restart. One extra request per attempt is within the edge's per-IP
 * budget.
 */
const ANON_RETRY_BACKOFF_MS = [400, 1200, 3000]

const JSON_HEADERS = { "Content-Type": "application/json" }

export async function fetchMeBody(request: RequestFn, accessToken: string): Promise<MeBody | null> {
  try {
    const res = await request("/me", { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return null
    return (await res.json()) as MeBody
  } catch {
    return null
  }
}

type AnonymousAttempt = { done: TokenResponseBody } | { retry: unknown }

/** A 429 (edge per-IP burst), a 408 and a 5xx (auth mid-deploy, DB blip) are
 *  recoverable later; any other 4xx is a real client error and fails fast. */
async function attemptAnonymous(request: RequestFn, init: RequestInit): Promise<AnonymousAttempt> {
  let res: Response
  try {
    res = await request("/anonymous", init)
  } catch (e) {
    return { retry: e }
  }
  if (res.ok) return { done: (await res.json()) as TokenResponseBody }
  const err = new Error(`auth/anonymous: HTTP ${res.status}`)
  if (res.status === 429 || res.status === 408 || res.status >= 500) return { retry: err }
  throw err
}

export async function callAnonymous(
  request: RequestFn,
  body: { deviceId: string; platform: string },
  bearer: string | null
): Promise<TokenResponseBody> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      // The raw stored token, not a refreshed one: getAccessToken() bootstraps
      // through here, so reading it back would recurse.
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  }

  let lastErr: unknown
  for (let attempt = 0; attempt <= ANON_RETRY_BACKOFF_MS.length; attempt++) {
    const outcome = await attemptAnonymous(request, init)
    if ("done" in outcome) return outcome.done
    lastErr = outcome.retry
    if (attempt < ANON_RETRY_BACKOFF_MS.length) await sleep(ANON_RETRY_BACKOFF_MS[attempt])
  }
  throw lastErr ?? new Error("auth/anonymous: retries exhausted")
}

/**
 * A refresh has three outcomes, not two: success, a genuine rejection (the
 * token is bad, expired or revoked → drop the session), and a transient
 * failure (backend mid-deploy, rate limit, offline → keep it and retry).
 * Collapsing the last two into "logout" signs users out after an update.
 */
export type RefreshOutcome =
  | { ok: true; body: TokenResponseBody }
  | { ok: false; rejected: boolean }

export async function callRefresh(
  request: RequestFn,
  refreshToken: string
): Promise<RefreshOutcome> {
  let res: Response
  try {
    res = await request("/refresh", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken }),
    })
  } catch {
    return { ok: false, rejected: false }
  }
  if (res.ok) return { ok: true, body: (await res.json()) as TokenResponseBody }
  return { ok: false, rejected: res.status === 401 || res.status === 403 }
}

export async function callSignin(
  request: RequestFn,
  provider: "google" | "apple",
  idToken: string,
  authHeader: Record<string, string>,
  fullName?: string
): Promise<TokenResponseBody> {
  const res = await request(`/signin/${provider}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...authHeader },
    body: JSON.stringify({ idToken, ...(fullName ? { fullName } : {}) }),
  })
  if (!res.ok) throw new Error(`auth/signin/${provider}: HTTP ${res.status}`)
  return (await res.json()) as TokenResponseBody
}
