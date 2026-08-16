import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * #1881. Share artifacts — Studio videos embedding the user's own note text,
 * note audio excerpts, transcript PDFs, inline recitations — used to be
 * written flat into `Directory.Cache`, while every sweep the app has ("Clear
 * cache" and "Delete account and also delete data on this device" both end at
 * `filesStorage.clearAll()`) enumerates a subtree of `Directory.Data`. Two
 * different storage volumes, so the wipe that promised to remove the user's
 * rendered private quotes never touched them.
 *
 * The regression this file guards is not "the adapter passes Directory.Data"
 * — that is one edit away from being true and still broken if the two roots
 * drift apart again. So both REAL adapters are mounted over ONE fake
 * filesystem: whatever the excerpt cache writes, the wipe then has to reach.
 */

type FakeEntry = { type: "file" | "directory"; size: number }

/** Fake `Directory.Data` volume, keyed by path. */
const data = new Map<string, FakeEntry>()

function putFile(path: string, size = 5_000_000): void {
  data.set(path, { type: "file", size })
  // Materialise the ancestors, as the native `mkdirs` does.
  const parts = path.split("/")
  for (let i = 1; i < parts.length; i++) {
    data.set(parts.slice(0, i).join("/"), { type: "directory", size: 0 })
  }
}

function listing(dir: string): { name: string; type: "file" | "directory" }[] {
  const prefix = `${dir}/`
  const names = new Set<string>()
  for (const path of data.keys()) {
    if (!path.startsWith(prefix)) continue
    names.add(path.slice(prefix.length).split("/")[0]!)
  }
  return [...names].map((name) => ({ name, type: data.get(`${dir}/${name}`)!.type }))
}

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE", Data: "DATA" },
  Filesystem: {
    stat: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      const entry = directory === "DATA" ? data.get(path) : undefined
      if (!entry) throw new Error("File does not exist")
      return { size: entry.size, type: entry.type }
    }),
    getUri: vi.fn(async ({ path, directory }: { path: string; directory: string }) => ({
      uri: `file:///${directory}/${path}`,
    })),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const entry = data.get(from)
      if (!entry) throw new Error("Source does not exist")
      data.delete(from)
      putFile(to, entry.size)
    }),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      data.delete(path)
    }),
    readdir: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
      if (directory !== "DATA" || data.get(path)?.type !== "directory") {
        throw new Error("Directory does not exist")
      }
      return { files: listing(path) }
    }),
    rmdir: vi.fn(async ({ path }: { path: string }) => {
      for (const key of [...data.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) data.delete(key)
      }
    }),
  },
}))

vi.mock("@capacitor/core", () => ({ Capacitor: { convertFileSrc: (u: string) => u } }))

type Listener = (event: unknown) => void
const listeners: { event: string; fn: Listener }[] = []

vi.mock("@shruti/plugin-media-downloader", () => ({
  MediaDownloader: {
    download: vi.fn(
      async ({
        id,
        destination,
      }: {
        id: string
        destination: { directory: string; subdir: string; filename: string }
      }) => {
        const path = destination.subdir
          ? `${destination.subdir}/${destination.filename}`
          : destination.filename
        expect(destination.directory).toBe("data")
        putFile(path)
        for (const l of listeners) {
          if (l.event === "completed") l.fn({ id, localUrl: `file:///DATA/${path}` })
        }
        return { id, state: "running", bytesDownloaded: 0, contentLength: 0 }
      }
    ),
    addListener: vi.fn(async (event: string, fn: Listener) => {
      const entry = { event, fn }
      listeners.push(entry)
      return {
        remove: async () => {
          const i = listeners.indexOf(entry)
          if (i >= 0) listeners.splice(i, 1)
        },
      }
    }),
    resolveLocalUrl: vi.fn(async () => ({ localUrl: null })),
    deleteFile: vi.fn(async () => undefined),
  },
}))

import { useCapacitorExcerptCache } from "@infra/excerptCache/capacitor/index.js"
import { useCapacitorRemoteFilesStorage } from "@infra/files/capacitor/index.js"
import { DATABASES_DIR } from "../contentDatabase.js"
import { EXCERPTS_DIR, MEDIA_ROOT_DIR } from "../storageLayout.js"

/** The wipe exactly as `main.ts` wires it — same root, same `keep` list. */
function wipe() {
  return useCapacitorRemoteFilesStorage({ cacheDir: MEDIA_ROOT_DIR, keep: [DATABASES_DIR] })
}

const cache = () => useCapacitorExcerptCache({ cacheDir: EXCERPTS_DIR })

/** One of every artifact the issue enumerates. */
const ARTIFACTS = [
  "share-video-note-42_a1b2c3d4e5f6.mp4",
  "share-audio-note-42.mp3",
  "transcript-trk1-en.pdf",
  "public_verses_bg_2_13_ru.mp3",
]

describe("share artifacts live where the wipe can reach them (#1881)", () => {
  beforeEach(() => {
    data.clear()
    listeners.length = 0
    putFile(`${MEDIA_ROOT_DIR}/${DATABASES_DIR}/content.db`, 54_000_000)
  })

  it("writes them under the storage root the wipe enumerates", async () => {
    const uri = await cache().download({
      url: "https://cdn.example.com/public/share/video/x.mp4",
      filename: ARTIFACTS[0]!,
    })

    expect(uri).toBe(`file:///DATA/${EXCERPTS_DIR}/${ARTIFACTS[0]!}`)
    expect(EXCERPTS_DIR.startsWith(`${MEDIA_ROOT_DIR}/`)).toBe(true)
    // …and NOT in the volume nothing enumerates.
    expect([...data.keys()].some((p) => p.includes("CACHE"))).toBe(false)
  })

  it("clearAll() deletes every rendered artifact", async () => {
    for (const filename of ARTIFACTS) {
      await cache().download({ url: `https://cdn.example.com/${filename}`, filename })
    }
    for (const filename of ARTIFACTS) {
      expect(await cache().findLocal(filename)).not.toBeNull()
    }

    await wipe().clearAll()

    for (const filename of ARTIFACTS) {
      expect(await cache().findLocal(filename)).toBeNull()
    }
    expect(data.has(EXCERPTS_DIR)).toBe(false)
  })

  it("keeps sparing the content catalog while taking the artifacts", async () => {
    await cache().download({
      url: "https://cdn.example.com/x.mp3",
      filename: ARTIFACTS[1]!,
    })

    await wipe().clearAll()

    // `keep` exists so a ~54 MB public download isn't collateral of "Clear
    // cache" (#1630) — the excerpt directory must never end up inside it.
    expect(data.has(`${MEDIA_ROOT_DIR}/${DATABASES_DIR}/content.db`)).toBe(true)
    expect(EXCERPTS_DIR).not.toBe(`${MEDIA_ROOT_DIR}/${DATABASES_DIR}`)
    expect(await cache().findLocal(ARTIFACTS[1]!)).toBeNull()
  })

  it("sweeps a `.tmp` orphan left by an interrupted excerpt download", async () => {
    putFile(`${EXCERPTS_DIR}/${ARTIFACTS[0]!}.tmp`, 1_200_000)

    await wipe().clearAll()

    expect(data.has(`${EXCERPTS_DIR}/${ARTIFACTS[0]!}.tmp`)).toBe(false)
  })
})
