import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IRemoteFilesStorage, IStoragePublicUrl } from "@ports/app/index.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import { createHttpTranscriptRepository } from "../transcriptRepository.http.js"

function repository(over: {
  path?: string | null
  languages?: readonly string[]
  cached?: string
}) {
  const tracks = {
    getTranscriptPath: async () => over.path ?? null,
    listTranscriptLanguages: async () => over.languages ?? [],
  } as unknown as ITrackRepository
  const filesStorage = {
    get: async (url: string) => over.cached ?? url,
  } as unknown as IRemoteFilesStorage
  const storagePublicUrl: IStoragePublicUrl = { get: (p) => `https://cdn.example/${p}` }
  return createHttpTranscriptRepository({ tracks, filesStorage, storagePublicUrl })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("createHttpTranscriptRepository", () => {
  it("answers the languages the track advertises", async () => {
    expect(await repository({ languages: ["en", "ru"] }).availableLanguages("t1")).toEqual([
      "en",
      "ru",
    ])
  })

  it("has a transcript exactly when the track advertises a path", async () => {
    expect(await repository({ path: "transcripts/t1/en.json" }).has("t1", "en")).toBe(true)
    expect(await repository({ path: null }).has("t1", "en")).toBe(false)
  })

  it("reads the transcript through the cached local copy", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ version: 2, blocks: [{ start: 0, end: 1, text: "hello" }] })
    )

    const transcript = await repository({
      path: "transcripts/t1/en.json",
      cached: "file:///cache/en.json",
    }).get("t1", "en")

    expect(fetchMock).toHaveBeenCalledWith("file:///cache/en.json")
    expect(transcript).toEqual({
      trackId: "t1",
      language: "en",
      version: 2,
      blocks: [{ start: 0, end: 1, text: "hello" }],
    })
  })

  it("assumes version 1 and no blocks for a transcript that omits them", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    const transcript = await repository({ path: "transcripts/t1/en.json" }).get("t1", "en")

    expect(transcript).toMatchObject({ version: 1, blocks: [] })
  })

  it("refuses a language the track does not advertise, without fetching", async () => {
    await expect(repository({ path: null }).get("t1", "de")).rejects.toThrow(
      "No transcript advertised for (t1, de)"
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports the status of a failed fetch", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404, statusText: "Not Found" }))

    await expect(repository({ path: "transcripts/t1/en.json" }).get("t1", "en")).rejects.toThrow(
      "Transcript fetch failed: 404 Not Found"
    )
  })

  it("names the file when its body is not JSON — a captive portal serves HTML with a 200", async () => {
    fetchMock.mockResolvedValue(new Response("<html>login</html>", { status: 200 }))

    await expect(repository({ path: "transcripts/t1/en.json" }).get("t1", "en")).rejects.toThrow(
      /Transcript JSON is malformed at transcripts\/t1\/en\.json/
    )
  })
})
