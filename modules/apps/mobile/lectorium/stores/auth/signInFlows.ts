import type { AuthPort, AuthSession, AuthStatus } from "@ports/app/auth.js"

export interface SignInFlowsDeps {
  /** Resolved per call — the port is created after the store. */
  readonly port: () => AuthPort
  readonly applySession: (s: AuthSession | null) => void
  readonly setStatus: (s: AuthStatus) => void
  /** Chases the server's tier, which may still be catching up with a purchase. */
  readonly onSignedIn: () => void
}

export interface SignInFlows {
  signInGoogle(): Promise<boolean>
  signInApple(): Promise<boolean>
  requestEmailCode(email: string): Promise<void>
  signInEmail(email: string, code: string): Promise<boolean>
}

export function createSignInFlows(deps: SignInFlowsDeps): SignInFlows {
  /** A cancelled provider sheet resolves to null; only a throw is an error. */
  async function signInWithProvider(
    provider: string,
    run: (port: AuthPort) => Promise<AuthSession | null>
  ): Promise<boolean> {
    const auth = deps.port()
    deps.setStatus("signingIn")
    try {
      const session = await run(auth)
      if (!session) {
        deps.applySession(auth.getSession())
        return false
      }
      deps.applySession(session)
      deps.onSignedIn()
      return true
    } catch (e) {
      console.error(`[auth] ${provider} sign-in failed:`, e)
      deps.setStatus("error")
      return false
    }
  }

  return {
    signInGoogle: () => signInWithProvider("google", (auth) => auth.signInWithGoogle()),
    signInApple: () => signInWithProvider("apple", (auth) => auth.signInWithApple()),

    /** Lets the EmailOtpError bubble so the modal can name the reason. */
    requestEmailCode: (email) => deps.port().requestEmailOtp(email),

    /** Rethrows on failure so the modal can surface "invalid code" inline. */
    signInEmail: async (email, code) => {
      const auth = deps.port()
      deps.setStatus("signingIn")
      try {
        deps.applySession(await auth.verifyEmailOtp(email, code))
        deps.onSignedIn()
        return true
      } catch (e) {
        deps.applySession(auth.getSession())
        throw e
      }
    },
  }
}
