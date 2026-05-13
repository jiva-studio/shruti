import { computed, onMounted, ref, type Ref } from "vue"
import { createAnimation, useIonRouter, type AnimationBuilder } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { bootstrapUserDatabaseFromApp } from "@shruti/services/bootstrap.js"
import { type ResolveContentDatabaseDeps } from "./composables/resolveContentDatabase.js"
import {
  checkForUpdatesInBackground as checkForUpdatesInBackgroundImpl,
  type CheckForUpdatesDeps,
} from "./composables/checkForUpdatesInBackground.js"
import { useDbSchemeRetry } from "./composables/useDbSchemeRetry.js"
import { PREFERRED_SERVER_KEY } from "@shruti/services/preferredServer.js"

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

  const viewState = ref<WelcomeViewState>("server:probing")
  const error = ref<string | null>(null)
  const progress = ref<number>(0)

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
      serverProber: shruti.serverProber,
      onServerResolved: (result) => shruti.setActiveServerById(result.serverId),
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

  const { resolveAndValidate } = useDbSchemeRetry({
    buildLocatorDeps,
    supportedScheme: SUPPORTED_DB_SCHEME,
    openContentDatabase: (path) => shruti.openContentDatabase(path),
    closeContentDatabase: () => shruti.closeContentDatabase(),
    readContentSchemeVersion: () => shruti.readContentSchemeVersion(),
    deleteLocalDb: (path) => shruti.databaseFetcher.delete(path),
    invalidateRemoteConfigCache: () =>
      shruti.filesStorage.delete(
        shruti.storagePublicUrl.get(shruti.appConfig.publicRemoteConfigPath)
      ),
  })

  async function bootstrapApp(): Promise<void> {
    viewState.value = "database:migrations"
    await bootstrapUserDatabaseFromApp(shruti)

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
      serverProber: shruti.serverProber,
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
