import { computed, onMounted, ref, type Ref } from "vue"
import { createAnimation, useIonRouter, type AnimationBuilder } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { runUserMigrations } from "@shruti/services/migrations/user/runMigrations.js"
import { probeServers } from "@infra/servers/index.js"
import { createSqlSchemeVersionRepository } from "@infra/repositories.sql/index.js"
import {
  resolveContentDatabase as resolveContentDatabaseImpl,
  type ResolveContentDatabaseDeps,
} from "./composables/resolveContentDatabase.js"
import {
  checkForUpdatesInBackground as checkForUpdatesInBackgroundImpl,
  type CheckForUpdatesDeps,
} from "./composables/checkForUpdatesInBackground.js"

const crossfadeAnimation: AnimationBuilder = (_, opts) => {
  const enter = createAnimation().addElement(opts.enteringEl).fromTo("opacity", 0, 1).duration(300)
  const leave = createAnimation().addElement(opts.leavingEl).fromTo("opacity", 1, 0).duration(300)
  return createAnimation().addAnimation([enter, leave])
}

/**
 * DB scheme this client is built against. Source of truth is
 * `modules/db-scheme.json`, injected via Vite `define` (see vite.config.ts).
 */
declare const __DB_SCHEME__: number
const SUPPORTED_DB_SCHEME = __DB_SCHEME__

const PREFERRED_SERVER_KEY = "preferredServerId"

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

export type WelcomeViewState =
  | "server:probing"
  | "config:downloading"
  | "database:check"
  | "database:downloading"
  | "database:migrations"
  | "complete"
  | "error"

export interface WelcomeControllerOptions {
  navigateToRoute?: string
  autoNavigate?: boolean
}

export interface WelcomeControllerReturn {
  viewState: Ref<WelcomeViewState>
  error: Ref<string | null>
  progress: Ref<number>
  isError: Ref<boolean>
  onRetry: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/*                              Core Dependencies                             */
/* -------------------------------------------------------------------------- */

export function useWelcomeController(
  options: WelcomeControllerOptions = {}
): WelcomeControllerReturn {
  const { navigateToRoute = "/tabs/home", autoNavigate = true } = options

  const ionRouter = useIonRouter()
  const shruti = useShruti()

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const viewState = ref<WelcomeViewState>("server:probing")
  const error = ref<string | null>(null)
  const progress = ref<number>(0)

  /* -------------------------------------------------------------------------- */
  /*                     Phase 1: Resolve Content Database                      */
  /* -------------------------------------------------------------------------- */

  const incompatibleDbPaths = new Set<string>()
  const MAX_SCHEME_RETRIES = 3

  function buildLocatorDeps(): ResolveContentDatabaseDeps {
    return {
      config: {
        remotePathTemplate: shruti.appConfig.database.remotePathTemplate,
        localPathTemplate: shruti.appConfig.database.localPathTemplate,
        publicRemoteConfigPath: shruti.appConfig.publicRemoteConfigPath,
      },
      supportedScheme: SUPPORTED_DB_SCHEME,
      getPublicUrl: (path) => shruti.storagePublicUrl.get(path),
      filesStorage: shruti.filesStorage,
      databaseFetcher: shruti.databaseFetcher,
      probeServers,
      onServerResolved: (result) => shruti.setActiveServer(result.server),
      loadSavedPreferredServerId: async () => {
        const stored = await shruti.preferences.get(PREFERRED_SERVER_KEY)
        return stored ?? undefined
      },
      setViewState: (value) => {
        viewState.value = value
      },
      setProgress: (percent) => {
        progress.value = percent
      },
    }
  }

  /* -------------------------------------------------------------------------- */
  /*       Phase 1 + 2 combined: resolve → open → validate, with retry cap     */
  /* -------------------------------------------------------------------------- */

  /**
   * Counter-based retry (vs. `Set.size > max`): even if the CDN keeps
   * advertising the same incompatible version, we still break out
   * after MAX_SCHEME_RETRIES attempts instead of looping forever.
   */
  async function resolveAndValidate(): Promise<void> {
    const observedSchemes: number[] = []

    for (let attempt = 0; attempt < MAX_SCHEME_RETRIES; attempt++) {
      const dbPath = await resolveContentDatabaseImpl(buildLocatorDeps(), incompatibleDbPaths)
      await shruti.openContentDatabase(dbPath)
      const scheme = await createSqlSchemeVersionRepository(shruti.databases.content!).read()

      if (scheme === 0 || scheme === SUPPORTED_DB_SCHEME) return

      // Scheme mismatch: close, mark, drop local copy, invalidate cached
      // config so the next iteration re-probes for a fresh manifest.
      observedSchemes.push(scheme)
      await shruti.closeContentDatabase()
      incompatibleDbPaths.add(dbPath)
      await shruti.databaseFetcher.delete(dbPath).catch(() => undefined)
      await shruti.filesStorage
        .delete(shruti.storagePublicUrl.get(shruti.appConfig.publicRemoteConfigPath))
        .catch(() => undefined)
    }

    const observed = observedSchemes.join(", ") || "none"
    throw new Error(
      `Content database scheme validation failed after ${MAX_SCHEME_RETRIES} attempts. ` +
        `Expected ${SUPPORTED_DB_SCHEME}, got: ${observed}. ` +
        `The CDN likely hasn't published a compatible DB yet — run ` +
        `content-db-builder, upload a new shruti.{version}.db with matching ` +
        `scheme, or bump modules/db-scheme.json to match what's available.`
    )
  }

  /* -------------------------------------------------------------------------- */
  /*                        Phase 3: Bootstrap Application                      */
  /* -------------------------------------------------------------------------- */

  async function bootstrapApp(): Promise<void> {
    viewState.value = "database:migrations"
    const userDbPath = shruti.appConfig.database.userLocalPath
    await shruti.openUserDatabase(userDbPath)
    await runUserMigrations(shruti.databases.user!)

    viewState.value = "complete"
    if (autoNavigate) {
      ionRouter.replace(navigateToRoute, crossfadeAnimation)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                      Background Database Update Check                      */
  /* -------------------------------------------------------------------------- */

  function buildUpdatesDeps(): CheckForUpdatesDeps {
    const base = buildLocatorDeps()
    return {
      config: base.config,
      supportedScheme: base.supportedScheme,
      getPublicUrl: base.getPublicUrl,
      filesStorage: base.filesStorage,
      databaseFetcher: base.databaseFetcher,
      probeServers,
      onServerResolved: base.onServerResolved,
      loadSavedPreferredServerId: base.loadSavedPreferredServerId,
      persistPreferredServerIdIfChanged: async (resolvedId) => {
        const current = await shruti.preferences.get(PREFERRED_SERVER_KEY)
        if (current !== resolvedId) {
          await shruti.preferences.set(PREFERRED_SERVER_KEY, resolvedId)
        }
      },
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            Initialization Flow                             */
  /* -------------------------------------------------------------------------- */

  async function initialize(): Promise<void> {
    try {
      error.value = null
      progress.value = 0

      await resolveAndValidate()
      await bootstrapApp()

      // Fire-and-forget: download newer DB version for next launch
      checkForUpdatesInBackgroundImpl(buildUpdatesDeps())
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to initialize"
      viewState.value = "error"
      error.value = errorMessage
      console.error("Initialization error:", err)
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  UI State                                  */
  /* -------------------------------------------------------------------------- */

  const isError = computed(() => viewState.value === "error")

  /* -------------------------------------------------------------------------- */
  /*                                 Lifecycle                                  */
  /* -------------------------------------------------------------------------- */

  onMounted(() => {
    initialize()
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Return                                   */
  /* -------------------------------------------------------------------------- */

  return {
    viewState,
    error,
    progress,
    isError,
    onRetry: initialize,
  }
}
