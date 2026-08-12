import { beforeAll, describe, expect, it } from "vitest"
import { ESLint } from "eslint"

/**
 * The layer boundaries are enforced by `eslint.config.js` and by nothing else,
 * so a hole in a `no-restricted-imports` block is invisible until someone
 * notices the import it let through. This runs the real config over synthetic
 * files at the real paths and asserts what it accepts and refuses.
 *
 * The hole this file was written for (#1742): every `ports/**` and `ui/**`
 * block banned `@infra/*`, `@lib/*`, `@ui/*`, `@lectorium/*` and `@capacitor/*`
 * — but not `@kit/*`. `@kit/infra` is where the shared toolkit keeps its
 * Capacitor adapters, so `import { useCapacitorShareService } from "@kit/infra"`
 * inside a view lints clean while `import { Share } from "@capacitor/share"`
 * two lines below does not. Same alias, same code, same layer violation.
 */

/** `modules/apps/mobile`, derived from this file rather than from `cwd` so
 *  the config is resolved the same way whoever runs vitest. */
const APP_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

let eslint: ESLint

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: `${APP_ROOT}/${filePath}`,
    warnIgnored: false,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId?.endsWith("no-restricted-imports"))
    .map((m) => m.message)
}

describe("layer boundaries", () => {
  beforeAll(() => {
    eslint = new ESLint({ cwd: APP_ROOT })
  })

  it("refuses a value import from @kit/infra in a port", async () => {
    expect(
      await messagesFor(
        "ports/app/__probe__.ts",
        `import { useCapacitorShareService } from "@kit/infra"\nexport const x = useCapacitorShareService\n`
      )
    ).not.toEqual([])
  })

  it("allows a port to re-export the interfaces kit owns, as types", async () => {
    // Every file under ports/app is a re-export shim for a kit-owned port
    // (`IPreferences`, `IShareService`, `IRemoteFilesStorage`, …). Banning
    // these would ban the layer's whole reason for existing.
    expect(
      await messagesFor(
        "ports/app/__probe__.ts",
        `export type { IShareService, ShareOptions } from "@kit/infra"\n`
      )
    ).toEqual([])
  })

  it("allows exactly one value through: the typed notifications error", async () => {
    // `notificationPlanner` does `err instanceof NotificationsDisabledError`,
    // which a type-only export cannot support. It is declared in kit's port
    // module, not in an adapter.
    expect(
      await messagesFor(
        "ports/app/__probe__.ts",
        `export { NotificationsDisabledError } from "@kit/infra"\n`
      )
    ).toEqual([])
    // …and the exception is by NAME, so it does not reopen the door.
    expect(
      await messagesFor(
        "ports/app/__probe__.ts",
        `export { NotificationsDisabledError, useCapacitorNotificationScheduler } from "@kit/infra"\n`
      )
    ).not.toEqual([])
  })

  it.each([
    "ui/__probe__.ts",
    "ui/primitives/__probe__.ts",
    "ui/icons/__probe__.ts",
    "ui/components/__probe__.ts",
    "ui/features/__probe__.ts",
    "submodules/ui/__probe__.ts",
    "submodules/chat/__probe__.ts",
  ])("refuses a value import from @kit/infra in %s", async (filePath) => {
    const code = `import { useCapacitorShareService } from "@kit/infra"\nexport const x = useCapacitorShareService\n`
    expect(await messagesFor(filePath, code)).not.toEqual([])
  })

  it.each([
    "ui/__probe__.ts",
    "ui/primitives/__probe__.ts",
    "submodules/ui/__probe__.ts",
    "submodules/chat/__probe__.ts",
  ])("still allows a type-only kit import in %s", async (filePath) => {
    // `ui/primitives/filesStorageKey.ts` does exactly this today.
    expect(
      await messagesFor(filePath, `import type { IRemoteFilesStorage } from "@kit/infra"\n`)
    ).toEqual([])
  })

  it("keeps banning the Capacitor SDKs the @kit/infra ban sits next to", async () => {
    // Guards against a rewrite that swaps one entry for the other.
    expect(
      await messagesFor("ui/components/__probe__.ts", `import { Share } from "@capacitor/share"\n`)
    ).not.toEqual([])
    expect(
      await messagesFor("ports/app/__probe__.ts", `import { x } from "@infra/whatever.js"\n`)
    ).not.toEqual([])
  })
})
