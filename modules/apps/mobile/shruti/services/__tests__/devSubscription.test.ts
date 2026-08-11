import { describe, expect, it } from "vitest"
import {
  isDevBuild,
  isSubscriptionOverridable,
  subscriptionFromOverride,
} from "@shruti/services/devSubscription.js"

/**
 * The override exists so a test — or a reviewer on a preview build — can run
 * the app as Pro deliberately. The property that keeps that from being a way to
 * fake a subscription is that the "pro" direction is gated on a COMPILE-TIME
 * flag, so it is dead code in anything a user installs.
 *
 * Vitest compiles the shipped variant (`__BUILD_ID__: "test"`,
 * `__E2E_BUILD__: false` in vitest.config.ts), so these run against a build
 * shaped like a release one.
 */
describe("subscription override", () => {
  it("is not honoured at all on a build that is neither dev nor a test build", () => {
    expect(isDevBuild).toBe(false)
    expect(isSubscriptionOverridable).toBe(false)
    expect(subscriptionFromOverride("pro")).toBe(false)
    expect(subscriptionFromOverride("default")).toBe(false)
  })

  it("grants Pro only where the build opted in", () => {
    expect(subscriptionFromOverride("pro", true, false)).toBe(true)
    expect(subscriptionFromOverride("pro", false, false)).toBe(false)
  })

  it("takes Pro away on any build — the paywall stays reachable everywhere", () => {
    expect(subscriptionFromOverride("free", true, true)).toBe(false)
    expect(subscriptionFromOverride("free", false, true)).toBe(false)
  })

  it("leaves an unset override on the build's own behaviour", () => {
    expect(subscriptionFromOverride("default", true, true)).toBe(true)
    expect(subscriptionFromOverride("default", true, false)).toBe(false)
  })
})
