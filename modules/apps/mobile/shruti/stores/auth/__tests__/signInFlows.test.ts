import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthPort, AuthSession, AuthStatus } from "@ports/app/auth.js"
import { createSignInFlows } from "../signInFlows.js"

const SESSION = { userId: "u-1" } as unknown as AuthSession
const RESTORED = { userId: "u-restored" } as unknown as AuthSession

function harness(port: Partial<AuthPort>) {
  const applied: (AuthSession | null)[] = []
  const statuses: AuthStatus[] = []
  let signedIn = 0
  const flows = createSignInFlows({
    port: () => ({ getSession: () => null, ...port }) as AuthPort,
    applySession: (s) => void applied.push(s),
    setStatus: (s) => void statuses.push(s),
    onSignedIn: () => void signedIn++,
  })
  return { flows, applied, statuses, signedIn: () => signedIn }
}

describe("createSignInFlows", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("applies the returned session and signals sign-in on a successful provider flow", async () => {
    const h = harness({ signInWithGoogle: async () => SESSION })

    expect(await h.flows.signInGoogle()).toBe(true)
    expect(h.statuses).toEqual(["signingIn"])
    expect(h.applied).toEqual([SESSION])
    expect(h.signedIn()).toBe(1)
  })

  it("treats a cancelled provider sheet as a non-error and restores the port's session", async () => {
    const h = harness({ signInWithApple: async () => null, getSession: () => RESTORED })

    expect(await h.flows.signInApple()).toBe(false)
    expect(h.applied).toEqual([RESTORED])
    expect(h.statuses).toEqual(["signingIn"])
    expect(h.signedIn()).toBe(0)
  })

  it("moves to the error status when the provider throws, without applying a session", async () => {
    const h = harness({
      signInWithGoogle: async () => {
        throw new Error("network down")
      },
    })

    expect(await h.flows.signInGoogle()).toBe(false)
    expect(h.statuses).toEqual(["signingIn", "error"])
    expect(h.applied).toEqual([])
    expect(h.signedIn()).toBe(0)
  })

  it("lets a requestEmailCode failure bubble to the caller", async () => {
    const boom = new Error("rate limited")
    const h = harness({
      requestEmailOtp: async () => {
        throw boom
      },
    })

    await expect(h.flows.requestEmailCode("a@b.c")).rejects.toBe(boom)
    expect(h.statuses).toEqual([])
  })

  it("applies the verified session on a successful email sign-in", async () => {
    const seen: string[] = []
    const h = harness({
      verifyEmailOtp: async (email, code) => {
        seen.push(`${email}:${code}`)
        return SESSION
      },
    })

    expect(await h.flows.signInEmail("a@b.c", "123456")).toBe(true)
    expect(seen).toEqual(["a@b.c:123456"])
    expect(h.applied).toEqual([SESSION])
    expect(h.signedIn()).toBe(1)
  })

  it("rethrows an invalid code after restoring the port's session", async () => {
    const boom = new Error("invalid code")
    const h = harness({
      verifyEmailOtp: async () => {
        throw boom
      },
      getSession: () => RESTORED,
    })

    await expect(h.flows.signInEmail("a@b.c", "000000")).rejects.toBe(boom)
    expect(h.applied).toEqual([RESTORED])
    expect(h.signedIn()).toBe(0)
  })
})
