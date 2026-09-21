import { describe, expect, it, vi } from "vitest"
import type { ChatTurn } from "@lib/contracts"
import {
  fetchSessionTitle,
  fetchSuggestedQuestions,
  postFeedback,
  type QuestionsFocusInput,
} from "../chatEndpoints.js"

const TOKEN = () => Promise.resolve("tok")
const NO_TOKEN = () => Promise.resolve(null)

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const turns: ChatTurn[] = [{ role: "user", content: "who is Prabhupada?" }] as ChatTurn[]

describe("fetchSessionTitle", () => {
  it("returns the trimmed title", async () => {
    const request = vi.fn(async () => json(200, { title: "  On the Guru  " }))
    expect(await fetchSessionTitle(turns, "en", { request, getAccessToken: TOKEN })).toBe(
      "On the Guru"
    )
  })

  it("sends the turns and the language, bearing the token", async () => {
    const request = vi.fn(async () => json(200, { title: "t" }))
    await fetchSessionTitle(turns, "ru", { request, getAccessToken: TOKEN })
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/title")
    expect(JSON.parse(String(init.body))).toEqual({ messages: turns, lang: "ru" })
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("never calls the service for an empty conversation", async () => {
    const request = vi.fn(async () => json(200, { title: "t" }))
    expect(await fetchSessionTitle([], "en", { request, getAccessToken: TOKEN })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps the current title when the session is unrecoverable", async () => {
    const request = vi.fn(async () => json(200, { title: "t" }))
    expect(await fetchSessionTitle(turns, "en", { request, getAccessToken: NO_TOKEN })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ["an HTTP error", async () => json(500, {})],
    ["a network failure", async () => Promise.reject(new Error("offline"))],
    ["an unparseable body", async () => new Response("<html>", { status: 200 })],
    ["a blank title", async () => json(200, { title: "   " })],
    ["a non-string title", async () => json(200, { title: 42 })],
    ["no title at all", async () => json(200, {})],
  ])("keeps the current title on %s", async (_label, request) => {
    expect(
      await fetchSessionTitle(turns, "en", { request: request as never, getAccessToken: TOKEN })
    ).toBeNull()
  })
})

const focus: QuestionsFocusInput = {
  trackId: "t1",
  startMs: 1000,
  endMs: 2000,
  text: "a fragment",
}

describe("fetchSuggestedQuestions", () => {
  it("returns the trimmed chips", async () => {
    const request = vi.fn(async () => json(200, { questions: [" one ", "two"] }))
    expect(await fetchSuggestedQuestions(focus, "en", { request, getAccessToken: TOKEN })).toEqual([
      "one",
      "two",
    ])
  })

  it("drops entries that would render as an empty chip", async () => {
    const request = vi.fn(async () => json(200, { questions: ["ok", "", "   ", null, 7, {}] }))
    expect(await fetchSuggestedQuestions(focus, "en", { request, getAccessToken: TOKEN })).toEqual([
      "ok",
    ])
  })

  it("sends the focus under camelCase keys the server aliases", async () => {
    const request = vi.fn(async () => json(200, { questions: [] }))
    await fetchSuggestedQuestions(focus, "sr", { request, getAccessToken: TOKEN })
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/questions")
    expect(JSON.parse(String(init.body))).toEqual({ focus, lang: "sr" })
  })

  it.each([
    ["an HTTP error", async () => json(500, {})],
    ["a network failure", async () => Promise.reject(new Error("offline"))],
    ["an unparseable body", async () => new Response("<html>", { status: 200 })],
    ["a non-array payload", async () => json(200, { questions: "one" })],
    ["no payload at all", async () => json(200, {})],
  ])("renders no chips on %s", async (_label, request) => {
    expect(
      await fetchSuggestedQuestions(focus, "en", {
        request: request as never,
        getAccessToken: TOKEN,
      })
    ).toEqual([])
  })

  it("renders no chips when the session is unrecoverable", async () => {
    const request = vi.fn(async () => json(200, { questions: ["x"] }))
    expect(
      await fetchSuggestedQuestions(focus, "en", { request, getAccessToken: NO_TOKEN })
    ).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})

describe("postFeedback", () => {
  it("sends the message id as the hyphenless lowercase trace id", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    await postFeedback(
      { messageId: "8B1F0C2E-4A5D-4E6F-9A0B-1C2D3E4F5A6B", value: "up" },
      { request, getAccessToken: TOKEN }
    )
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/chat/feedback")
    expect(JSON.parse(String(init.body))).toEqual({
      trace_id: "8b1f0c2e4a5d4e6f9a0b1c2d3e4f5a6b",
      value: "up",
    })
  })

  it("omits the category and comment when they were not given", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    await postFeedback({ messageId: "abc", value: "up" }, { request, getAccessToken: TOKEN })
    const body = JSON.parse(
      String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    expect(Object.keys(body).sort()).toEqual(["trace_id", "value"])
  })

  it("carries the category and comment of a thumbs-down", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    await postFeedback(
      { messageId: "abc", value: "down", category: "bad_citations", comment: "wrong verse" },
      { request, getAccessToken: TOKEN }
    )
    const body = JSON.parse(
      String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    expect(body).toMatchObject({ category: "bad_citations", comment: "wrong verse" })
  })

  it("throws with the status so the caller can revert and retry", async () => {
    const request = vi.fn(async () => new Response("nope", { status: 503 }))
    await expect(
      postFeedback({ messageId: "abc", value: "up" }, { request, getAccessToken: TOKEN })
    ).rejects.toThrow(/503/)
  })

  it("throws when the session is unrecoverable", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(
      postFeedback({ messageId: "abc", value: "up" }, { request, getAccessToken: NO_TOKEN })
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})
