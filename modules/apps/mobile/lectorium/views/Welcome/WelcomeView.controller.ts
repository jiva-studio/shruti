import { computed, onMounted, ref, type Ref } from "vue"
import { createAnimation, useIonRouter, type AnimationBuilder } from "@ionic/vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { runUserMigrations } from "@lectorium/services/migrations/user/runMigrations.js"
import { type ResolveContentDatabaseDeps } from "./composables/resolveContentDatabase.js"
import {
  checkForUpdatesInBackground as checkForUpdatesInBackgroundImpl,
  type CheckForUpdatesDeps,
} from "./composables/checkForUpdatesInBackground.js"
import { useDbSchemeRetry } from "./composables/useDbSchemeRetry.js"

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
  const lectorium = useLectorium()

  const viewState = ref<WelcomeViewState>("server:probing")
  const error = ref<string | null>(null)
  const progress = ref<number>(0)

  function buildLocatorDeps(): ResolveContentDatabaseDeps {
    return {
      config: {
        remotePathTemplate: lectorium.appConfig.database.remotePathTemplate,
        localPathTemplate: lectorium.appConfig.database.localPathTemplate,
        publicRemoteConfigPath: lectorium.appConfig.publicRemoteConfigPath,
      },
      supportedScheme: SUPPORTED_DB_SCHEME,
      getPublicUrl: (path) => lectorium.storagePublicUrl.get(path),
      filesStorage: lectorium.filesStorage,
      databaseFetcher: lectorium.databaseFetcher,
      serverProber: lectorium.serverProber,
      onServerResolved: (result) => lectorium.setActiveServerById(result.serverId),
      loadSavedPreferredServerId: async () => {
        const stored = await lectorium.preferences.get(PREFERRED_SERVER_KEY)
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

  const { resolveAndValidate } = useDbSchemeRetry({
    buildLocatorDeps,
    supportedScheme: SUPPORTED_DB_SCHEME,
    openContentDatabase: (path) => lectorium.openContentDatabase(path),
    closeContentDatabase: () => lectorium.closeContentDatabase(),
    readContentSchemeVersion: () => lectorium.readContentSchemeVersion(),
    deleteLocalDb: (path) => lectorium.databaseFetcher.delete(path),
    invalidateRemoteConfigCache: () =>
      lectorium.filesStorage.delete(
        lectorium.storagePublicUrl.get(lectorium.appConfig.publicRemoteConfigPath)
      ),
  })

  async function bootstrapApp(): Promise<void> {
    viewState.value = "database:migrations"
    const userDbPath = lectorium.appConfig.database.userLocalPath
    await lectorium.openUserDatabase(userDbPath)
    await runUserMigrations(lectorium.databases.user!)

    viewState.value = "complete"
    if (autoNavigate) {
      ionRouter.replace(navigateToRoute, crossfadeAnimation)
    }
  }

  function buildUpdatesDeps(): CheckForUpdatesDeps {
    const base = buildLocatorDeps()
    return {
      config: base.config,
      supportedScheme: base.supportedScheme,
      getPublicUrl: base.getPublicUrl,
      filesStorage: base.filesStorage,
      databaseFetcher: base.databaseFetcher,
      serverProber: lectorium.serverProber,
      onServerResolved: base.onServerResolved,
      loadSavedPreferredServerId: base.loadSavedPreferredServerId,
      persistPreferredServerIdIfChanged: async (resolvedId) => {
        const current = await lectorium.preferences.get(PREFERRED_SERVER_KEY)
        if (current !== resolvedId) {
          await lectorium.preferences.set(PREFERRED_SERVER_KEY, resolvedId)
        }
      },
    }
  }

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

  const isError = computed(() => viewState.value === "error")

  onMounted(() => {
    initialize()
  })

  return {
    viewState,
    error,
    progress,
    isError,
    onRetry: initialize,
  }
}
