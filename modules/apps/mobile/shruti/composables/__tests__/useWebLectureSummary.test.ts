import { describe, expect, it, vi, beforeEach } from "vitest"
import { ref } from "vue"
import type { DiscoveryHit } from "@lib/contracts"
import { cleanExcerpt, useWebLectureSummary } from "../useWebLectureSummary.js"
import { __resetShrutiForTests, initShruti } from "@shruti/shruti.js"
import type { InitShrutiSeed } from "@shruti/services/shrutiTypes.js"

function createTestSeed(chatHttpRequestMock: any): InitShrutiSeed {
  return {
    appConfig: {
      database: {
        localPathTemplate: "content.db",
        remotePathTemplate: "db/shruti.{version}.db",
        userLocalPath: "user.db",
      },
      publicRemoteConfigPath: "config.json",
    },
    persistence: { open: vi.fn(), deleteDatabase: vi.fn() },
    auth: { getSession: () => null, getAccessToken: () => Promise.resolve("mock-token") },
    preferences: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    chatHttpRequest: chatHttpRequestMock,
    databaseTransferFactory: () => ({}),
    platform: "web",
    initialServer: {
      id: "global",
      name: "Global",
      urlTemplate: "https://example.com/{path}",
    },
  } as unknown as InitShrutiSeed
}

describe("cleanExcerpt", () => {
  it("strips timestamp prefixes and brackets", () => {
    expect(cleanExcerpt("00:06:41: In this lecture we discuss karma.")).toBe(
      "In this lecture we discuss karma."
    )
    expect(cleanExcerpt("[12:34] Some topic discussion.")).toBe("Some topic discussion.")
    expect(cleanExcerpt("(01:23:45) Another discussion topic.")).toBe("Another discussion topic.")
    expect(cleanExcerpt("12:34 - Discussion start.")).toBe("Discussion start.")
  })

  it("strips speaker tags and redundant whitespace", () => {
    expect(cleanExcerpt("Speaker 1: Hello everyone, welcome.")).toBe("Hello everyone, welcome.")
    expect(cleanExcerpt("Author: Important wisdom shared here.")).toBe(
      "Important wisdom shared here."
    )
    expect(cleanExcerpt("   Lots   of    spaces   and newlines \n\n here.  ")).toBe(
      "Lots of spaces and newlines here."
    )
  })

  it("handles empty or null gracefully", () => {
    expect(cleanExcerpt(null)).toBe("")
    expect(cleanExcerpt(undefined)).toBe("")
    expect(cleanExcerpt("")).toBe("")
  })
})

describe("useWebLectureSummary", () => {
  beforeEach(() => {
    __resetShrutiForTests()
  })

  it("immediately returns cleaned excerpt and updates with AI stream", async () => {
    const sseBody =
      'event: delta\ndata: {"text":"AI generated summary of the lecture."}\n\nevent: done\ndata: {}\n\n'
    const chatHttpRequestMock = vi.fn().mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    )
    initShruti(createTestSeed(chatHttpRequestMock))

    const hit = ref<DiscoveryHit | null>({
      item_id: 1,
      media_url: "https://example.com/audio.mp3",
      title: "Science of Self Realization",
      author: "Radhanath Swami",
      chunk: "00:05:12: Raw excerpt text from lecture.",
      score: 1.0,
    })

    const { summary, isAiGenerated, isLoading } = useWebLectureSummary(hit)

    // Initial value is immediately cleaned excerpt
    expect(summary.value).toBe("Raw excerpt text from lecture.")

    // Wait for the async LLM stream
    await new Promise((r) => setTimeout(r, 50))

    expect(chatHttpRequestMock).toHaveBeenCalled()
    expect(summary.value).toBe("AI generated summary of the lecture.")
    expect(isAiGenerated.value).toBe(true)
    expect(isLoading.value).toBe(false)
  })

  it("falls back to cleaned excerpt if LLM streaming throws", async () => {
    const chatHttpRequestMock = vi.fn().mockRejectedValue(new Error("Network error"))
    initShruti(createTestSeed(chatHttpRequestMock))

    const hit = ref<DiscoveryHit | null>({
      item_id: 2,
      media_url: "https://example.com/audio2.mp3",
      title: "Bhagavad Gita",
      chunk: "00:01:00: Essential verses explained.",
      score: 1.0,
    })

    const { summary, isAiGenerated } = useWebLectureSummary(hit)

    expect(summary.value).toBe("Essential verses explained.")
    await new Promise((r) => setTimeout(r, 50))
    expect(summary.value).toBe("Essential verses explained.")
    expect(isAiGenerated.value).toBe(false)
  })
})
