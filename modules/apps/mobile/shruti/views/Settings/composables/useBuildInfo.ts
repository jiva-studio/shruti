import { computed, type ComputedRef } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"

export interface BuildInfo {
  readonly version: string
  /** Build number plus the short commit hash, e.g. "2015 · a1b2c3d". The hash
   *  is empty in local builds. */
  readonly buildId: string
  readonly dbScheme: number
  activeServer: ComputedRef<CdnServer>
  contentDbFile: ComputedRef<string | null>
  /** The timestamp out of "shruti.20260419213357.db", or the raw filename
   *  if the shape changes, so the footer still renders something readable. */
  dbNumber: ComputedRef<string | null>
}

export function useBuildInfo(): BuildInfo {
  const app = useShruti()
  return {
    version: __APP_VERSION__,
    buildId: __COMMIT_SHA__ ? `${__BUILD_ID__} · ${__COMMIT_SHA__}` : __BUILD_ID__,
    dbScheme: __DB_SCHEME__,
    activeServer: computed(() => app.activeServer.value),
    contentDbFile: computed(() => app.contentDbFile.value),
    dbNumber: computed(() => {
      const file = app.contentDbFile.value
      if (!file) return null
      const match = /\.(\d+)\.db$/.exec(file)
      return match ? match[1] : file
    }),
  }
}

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __COMMIT_SHA__: string
declare const __DB_SCHEME__: number
