import { describe, it, expect, vi } from "vitest"
import type { IRemoteFilesStorage } from "../files/remoteFilesStorage.js"
import { createJsonRemoteStorage } from "../files/jsonRemoteStorage.js"

function fakeStorage(getText: IRemoteFilesStorage["getText"]): IRemoteFilesStorage {
  return {
    get: vi.fn(),
    getText,
    has: vi.fn(),
    delete: vi.fn(),
    clearAll: vi.fn(),
  }
}

describe("createJsonRemoteStorage", () => {
  it("parses the text body returned by the wrapped storage", async () => {
    const getText = vi.fn(async () => '{"a":1,"b":"x"}')
    const json = createJsonRemoteStorage(fakeStorage(getText))
    expect(await json.getJson("https://cdn/c.json")).toEqual({ a: 1, b: "x" })
  })

  it("hands getText a validator that rejects non-JSON before it is cached", async () => {
    let captured: ((t: string) => void) | undefined
    const getText = vi.fn(async (_url: string, opts?: { validate?: (t: string) => void }) => {
      captured = opts?.validate
      return '{"ok":true}'
    })
    await createJsonRemoteStorage(fakeStorage(getText)).getJson("https://cdn/c.json")

    expect(captured).toBeTypeOf("function")
    // A captive-portal HTML page must throw (so getText skips the cache write)…
    expect(() => captured?.("<html>nope</html>")).toThrow()
    // …while real JSON passes.
    expect(() => captured?.('{"x":1}')).not.toThrow()
  })
})
