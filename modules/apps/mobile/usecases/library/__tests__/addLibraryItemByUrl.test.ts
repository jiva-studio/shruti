import { describe, expect, it, vi } from "vitest"
import type { IIngestClient } from "@lib/contracts"
import {
  addLibraryItemByUrl,
  FREE_TIER_IMPORT_LIMIT,
  type AddLibraryItemByUrlDeps,
} from "../addLibraryItemByUrl.js"

function makeDeps(overrides: Partial<AddLibraryItemByUrlDeps> = {}): {
  deps: AddLibraryItemByUrlDeps
  openPaywall: ReturnType<typeof vi.fn>
  submit: ReturnType<typeof vi.fn>
  claimSource: ReturnType<typeof vi.fn>
} {
  const openPaywall = vi.fn().mockResolvedValue(undefined)
  const submit = vi.fn().mockResolvedValue({ membership_id: "mem-1" })
  const claimSource = vi.fn().mockReturnValue(true)

  const deps: AddLibraryItemByUrlDeps = {
    ensurePro: vi.fn().mockResolvedValue(true),
    isPro: () => true,
    externalItemCount: () => 0,
    openPaywall,
    library: {
      findBySource: () => undefined,
      isArchived: () => false,
      restore: vi.fn().mockResolvedValue(undefined),
      claimSource,
      releaseSource: vi.fn(),
      recordSubmission: vi.fn(),
    },
    ingest: { submit } as Pick<IIngestClient, "submit">,
    requestSync: vi.fn(),
    ...overrides,
  }

  return { deps, openPaywall, submit, claimSource }
}

describe("addLibraryItemByUrl starter quota", () => {
  it("defines FREE_TIER_IMPORT_LIMIT as 10", () => {
    expect(FREE_TIER_IMPORT_LIMIT).toBe(10)
  })

  it("allows free users below the limit (< 10) to import", async () => {
    const { deps, submit, openPaywall } = makeDeps({
      isPro: () => false,
      externalItemCount: () => 5,
    })

    const result = await addLibraryItemByUrl("https://youtube.com/watch?v=abc", undefined, deps)

    expect(result).toBe("added")
    expect(submit).toHaveBeenCalledWith({
      url: "https://youtube.com/watch?v=abc",
      title: undefined,
      author: undefined,
    })
    expect(openPaywall).not.toHaveBeenCalled()
  })

  it("bounces free users at or above limit (>= 10) to paywall", async () => {
    const { deps, submit, openPaywall } = makeDeps({
      isPro: () => false,
      externalItemCount: () => 10,
    })

    const result = await addLibraryItemByUrl("https://youtube.com/watch?v=abc", undefined, deps)

    expect(result).toBe("paywalled")
    expect(openPaywall).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })

  it("allows pro users with >= 10 items to import without paywall", async () => {
    const { deps, submit, openPaywall } = makeDeps({
      isPro: () => true,
      externalItemCount: () => 25,
    })

    const result = await addLibraryItemByUrl("https://youtube.com/watch?v=abc", undefined, deps)

    expect(result).toBe("added")
    expect(submit).toHaveBeenCalled()
    expect(openPaywall).not.toHaveBeenCalled()
  })

  it("respects dynamic limit passed via deps.limit", async () => {
    const { deps, submit, openPaywall } = makeDeps({
      isPro: () => false,
      externalItemCount: () => 3,
      limit: () => 3,
    })

    const result = await addLibraryItemByUrl("https://youtube.com/watch?v=abc", undefined, deps)

    expect(result).toBe("paywalled")
    expect(openPaywall).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })
})
