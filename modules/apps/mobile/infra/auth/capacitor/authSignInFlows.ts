import { EmailOtpError, type AuthConfig, type AuthSession } from "@ports/app/auth.js"

import { emailOtpErrorFromResponse, isConnectivityError } from "./authErrors.js"
import { callSignin } from "./authHttp.js"
import type { TokenResponseBody } from "./authTokens.js"
import { requestAppleCredential, requestGoogleIdToken } from "./socialSignIn.js"

export interface SignInFlowDeps {
  readonly request: AuthConfig["request"]
  readonly getLocale: () => string
  readonly ensureSocialInit: () => Promise<void>
  /** The bearer that tells the server to upgrade this device's user in place. */
  readonly authHeader: () => Promise<Record<string, string>>
  readonly readDeviceId: () => Promise<string>
  readonly commit: (body: TokenResponseBody) => Promise<AuthSession>
}

export interface SignInFlows {
  signInWithGoogle: () => Promise<AuthSession | null>
  signInWithApple: () => Promise<AuthSession | null>
  requestEmailOtp: (email: string) => Promise<void>
  verifyEmailOtp: (email: string, code: string) => Promise<AuthSession>
}

export function createSignInFlows(deps: SignInFlowDeps): SignInFlows {
  async function postOtp(path: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await deps.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await deps.authHeader()) },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new EmailOtpError(isConnectivityError(e) ? "network" : "server")
    }
  }

  return {
    async signInWithGoogle(): Promise<AuthSession | null> {
      await deps.ensureSocialInit()
      const idToken = await requestGoogleIdToken()
      if (!idToken) return null
      return deps.commit(await callSignin(deps.request, "google", idToken, await deps.authHeader()))
    },

    async signInWithApple(): Promise<AuthSession | null> {
      await deps.ensureSocialInit()
      const credential = await requestAppleCredential()
      if (!credential) return null
      const tokens = await callSignin(
        deps.request,
        "apple",
        credential.idToken,
        await deps.authHeader(),
        credential.fullName
      )
      return deps.commit(tokens)
    },

    async requestEmailOtp(email: string): Promise<void> {
      const res = await postOtp("/signin/email/request", { email, locale: deps.getLocale() })
      if (!res.ok) throw emailOtpErrorFromResponse(res)
    },

    async verifyEmailOtp(email: string, code: string): Promise<AuthSession> {
      const deviceId = await deps.readDeviceId()
      const res = await postOtp("/signin/email/verify", { email, code, deviceId })
      if (!res.ok) throw emailOtpErrorFromResponse(res)
      return deps.commit((await res.json()) as TokenResponseBody)
    },
  }
}
