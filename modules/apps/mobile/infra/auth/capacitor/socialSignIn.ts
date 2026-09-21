import { SocialLogin } from "@capgo/capacitor-social-login"

/** One initialization per adapter, attempted once whether or not it worked. */
export function createSocialInit(cfg: {
  googleWebClientId: string
  googleIOSClientId?: string
}): () => Promise<void> {
  let initialized = false
  return async () => {
    if (initialized) return
    initialized = true
    try {
      await SocialLogin.initialize({
        google: { webClientId: cfg.googleWebClientId, iOSClientId: cfg.googleIOSClientId },
      })
    } catch (e) {
      console.warn("[auth] social-login init failed", e)
    }
  }
}

/** The Google id token the server can verify, or null when the user backed out
 *  or the response was not an online one carrying a token. */
export async function requestGoogleIdToken(): Promise<string | null> {
  let result
  try {
    result = await SocialLogin.login({ provider: "google", options: {} })
  } catch (e) {
    console.warn("[auth] google login canceled or failed", e)
    return null
  }
  if (result.provider !== "google" || result.result?.responseType !== "online") return null
  return result.result.idToken ?? null
}

export interface AppleCredential {
  idToken: string
  /** Apple sends the name only on the very first authorization. */
  fullName?: string
}

/** 1001 is the user cancelling and 1000 a connectivity failure; both mean
 *  "no sign-in happened", not "sign-in broke". */
function isAppleCancellation(e: unknown): boolean {
  const msg = String((e as { errorMessage?: string } | null)?.errorMessage ?? "")
  return msg.includes("1001") || msg.includes("1000")
}

/** Null when the user backed out; a failure for any other reason is thrown. */
async function loginApple() {
  try {
    return await SocialLogin.login({ provider: "apple", options: {} })
  } catch (e: unknown) {
    if (isAppleCancellation(e)) return null
    console.warn("[auth] apple login failed", e)
    throw e
  }
}

export async function requestAppleCredential(): Promise<AppleCredential | null> {
  const result = await loginApple()
  if (result === null || result.provider !== "apple") return null
  const idToken = result.result?.idToken
  if (!idToken) return null
  const { givenName, familyName } = result.result.profile ?? {}
  const fullName = [givenName, familyName].filter(Boolean).join(" ").trim()
  return { idToken, fullName: fullName || undefined }
}
