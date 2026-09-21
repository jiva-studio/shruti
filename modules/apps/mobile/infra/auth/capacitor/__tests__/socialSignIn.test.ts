import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AppleProviderResponse,
  GoogleLoginResponse,
  InitializeOptions,
  LoginResult,
} from "@capgo/capacitor-social-login"

const initialized: InitializeOptions[] = []
const initialize = vi.fn(async (options: InitializeOptions) => {
  initialized.push(options)
})
const login = vi.fn<() => Promise<LoginResult>>()

vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: {
    initialize: (options: InitializeOptions) => initialize(options),
    login: () => login(),
  },
}))

const { createSocialInit, requestAppleCredential, requestGoogleIdToken } =
  await import("../socialSignIn.js")

function googleOnline(idToken: string | null): GoogleLoginResponse {
  return {
    accessToken: null,
    idToken,
    profile: {
      email: "user@example.com",
      familyName: null,
      givenName: null,
      id: "g1",
      name: null,
      imageUrl: null,
    },
    responseType: "online",
  }
}

function appleResponse(over: Partial<AppleProviderResponse> = {}): AppleProviderResponse {
  return {
    accessToken: null,
    idToken: "apple-id-token",
    profile: { user: "a1", email: null, givenName: null, familyName: null },
    ...over,
  }
}

function appleError(message: string): { errorMessage: string } {
  return { errorMessage: message }
}

describe("createSocialInit", () => {
  beforeEach(() => {
    initialized.length = 0
    initialize.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("hands the plugin both configured Google client ids", async () => {
    await createSocialInit({ googleWebClientId: "web-1", googleIOSClientId: "ios-1" })()

    expect(initialized).toEqual([{ google: { webClientId: "web-1", iOSClientId: "ios-1" } }])
  })

  it("leaves the iOS client id unset when none is configured", async () => {
    await createSocialInit({ googleWebClientId: "web-1" })()

    expect(initialized[0]).toEqual({ google: { webClientId: "web-1", iOSClientId: undefined } })
  })

  it("initializes once however many sign-ins follow", async () => {
    const init = createSocialInit({ googleWebClientId: "web-1" })
    await init()
    await init()
    await init()

    expect(initialized).toHaveLength(1)
  })

  it("resolves after a failed initialization instead of rejecting the sign-in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    initialize.mockRejectedValueOnce(new Error("plugin unavailable"))

    await expect(createSocialInit({ googleWebClientId: "web-1" })()).resolves.toBeUndefined()
  })

  it("does not retry an initialization that already failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    initialize.mockRejectedValueOnce(new Error("plugin unavailable"))
    const init = createSocialInit({ googleWebClientId: "web-1" })

    await init()
    await init()

    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it("keeps two adapters independent of each other's initialization", async () => {
    await createSocialInit({ googleWebClientId: "web-1" })()
    await createSocialInit({ googleWebClientId: "web-2" })()

    expect(initialized.map((o) => o.google?.webClientId)).toEqual(["web-1", "web-2"])
  })
})

describe("requestGoogleIdToken", () => {
  beforeEach(() => {
    login.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the id token the server can verify", async () => {
    login.mockResolvedValue({ provider: "google", result: googleOnline("id-token-1") })

    await expect(requestGoogleIdToken()).resolves.toBe("id-token-1")
  })

  it("returns null when the user backs out of the account chooser", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue(new Error("The user canceled the sign-in flow"))

    await expect(requestGoogleIdToken()).resolves.toBeNull()
  })

  it("returns null when the provider itself fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue(new Error("10: DEVELOPER_ERROR"))

    await expect(requestGoogleIdToken()).resolves.toBeNull()
  })

  it("returns null for an offline response, which carries a code and no token", async () => {
    login.mockResolvedValue({
      provider: "google",
      result: { serverAuthCode: "code-1", responseType: "offline" },
    })

    await expect(requestGoogleIdToken()).resolves.toBeNull()
  })

  it("returns null when the online response carries no id token", async () => {
    login.mockResolvedValue({ provider: "google", result: googleOnline(null) })

    await expect(requestGoogleIdToken()).resolves.toBeNull()
  })

  it("returns null when the plugin answers for a different provider", async () => {
    login.mockResolvedValue({ provider: "apple", result: appleResponse() })

    await expect(requestGoogleIdToken()).resolves.toBeNull()
  })
})

describe("requestAppleCredential", () => {
  beforeEach(() => {
    login.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the id token and the name Apple sends on a first authorization", async () => {
    login.mockResolvedValue({
      provider: "apple",
      result: appleResponse({
        idToken: "apple-1",
        profile: { user: "a1", email: null, givenName: "Ada", familyName: "Lovelace" },
      }),
    })

    await expect(requestAppleCredential()).resolves.toEqual({
      idToken: "apple-1",
      fullName: "Ada Lovelace",
    })
  })

  it("returns the given name alone when Apple withholds the family name", async () => {
    login.mockResolvedValue({
      provider: "apple",
      result: appleResponse({
        profile: { user: "a1", email: null, givenName: "Ada", familyName: null },
      }),
    })

    await expect(requestAppleCredential()).resolves.toEqual({
      idToken: "apple-id-token",
      fullName: "Ada",
    })
  })

  it("reports no name on a repeat authorization, where Apple sends none", async () => {
    login.mockResolvedValue({ provider: "apple", result: appleResponse() })

    const credential = await requestAppleCredential()

    expect(credential).toEqual({ idToken: "apple-id-token", fullName: undefined })
  })

  it("returns null when the user cancels the Apple sheet", async () => {
    login.mockRejectedValue(appleError("The operation couldn't be completed. (error 1001.)"))

    await expect(requestAppleCredential()).resolves.toBeNull()
  })

  it("returns null when Apple cannot be reached", async () => {
    login.mockRejectedValue(appleError("The operation couldn't be completed. (error 1000.)"))

    await expect(requestAppleCredential()).resolves.toBeNull()
  })

  it("throws any other Apple failure so the caller can surface it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue(appleError("AuthorizationError error 1004 (not handled)"))

    await expect(requestAppleCredential()).rejects.toEqual(
      appleError("AuthorizationError error 1004 (not handled)")
    )
  })

  it("throws a failure carrying no error message at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue(new Error("plugin not installed"))

    await expect(requestAppleCredential()).rejects.toThrow("plugin not installed")
  })

  it("returns null when the plugin answers for a different provider", async () => {
    login.mockResolvedValue({ provider: "google", result: googleOnline("id-token-1") })

    await expect(requestAppleCredential()).resolves.toBeNull()
  })

  it("returns null when the Apple response carries no id token", async () => {
    login.mockResolvedValue({ provider: "apple", result: appleResponse({ idToken: null }) })

    await expect(requestAppleCredential()).resolves.toBeNull()
  })
})
