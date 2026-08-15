// @vitest-environment jsdom
/**
 * Qase case 350. The storage-error screen's escape hatch (#1831): everything
 * below the confirm dialog is real — `resetLocalUserDatabaseFromApp` runs
 * against a composition root whose `repositories()` throws, the way it does
 * when the user database never opened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Shruti } from "@shruti/shruti.js"

const dismissRole = vi.hoisted(() => ({ value: "cancel" as string | undefined }))
const created = vi.hoisted(() => [] as Record<string, unknown>[])
const app = vi.hoisted(() => ({ value: null as unknown as Shruti }))

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock("@ionic/vue", () => ({
  alertController: {
    create: async (options: Record<string, unknown>) => {
      created.push(options)
      return {
        present: async () => undefined,
        onDidDismiss: async () => ({ role: dismissRole.value }),
      }
    },
  },
}))
vi.mock("@shruti/shruti.js", () => ({ useShruti: () => app.value }))

import { useStorageErrorActions } from "../useStorageErrorActions.js"

function makeApp(deleteDatabase: () => Promise<void>): Shruti {
  return {
    appConfig: { database: { userLocalPath: "user.db" } },
    closeUserDatabase: async () => undefined,
    persistence: { deleteDatabase },
    repositories: () => {
      throw new Error("repositories(): user DB is not open yet")
    },
  } as unknown as Shruti
}

beforeEach(() => {
  created.length = 0
  dismissRole.value = "cancel"
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "unchanged" },
  })
})

describe("useStorageErrorActions.onReset", () => {
  it("deletes nothing when the confirm is dismissed", async () => {
    const deleteDatabase = vi.fn().mockResolvedValue(undefined)
    app.value = makeApp(deleteDatabase)

    await useStorageErrorActions().onReset()

    expect(deleteDatabase).not.toHaveBeenCalled()
    expect(window.location.href).toBe("unchanged")
  })

  it("deletes the user database and re-bootstraps once confirmed", async () => {
    dismissRole.value = "destructive"
    const deleteDatabase = vi.fn().mockResolvedValue(undefined)
    app.value = makeApp(deleteDatabase)

    await useStorageErrorActions().onReset()

    expect(deleteDatabase).toHaveBeenCalledWith("user.db")
    // A hard reload, not a router push: bootstrap runs once, before mount.
    expect(window.location.href).toBe("/")
  })

  it("reports a failed reset and stays on the screen", async () => {
    dismissRole.value = "destructive"
    app.value = makeApp(async () => {
      throw new Error("read-only file system")
    })

    const actions = useStorageErrorActions()
    await actions.onReset()

    // Reloading into the same broken bootstrap would hide the reason; the
    // underlying message is the one thing that makes a bug report actionable.
    expect(window.location.href).toBe("unchanged")
    expect(created.at(-1)?.message).toBe("read-only file system")
    expect(actions.busy.value).toBe(false)
  })
})
