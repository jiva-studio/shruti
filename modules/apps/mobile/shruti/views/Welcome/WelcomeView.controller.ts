import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { createAnimation, useIonRouter, type AnimationBuilder } from "@ionic/vue"
import {
  createBootstrapController,
  type BootstrapPhase,
  type ProbeResult,
  type ResolveContentDatabaseOptions,
} from "@kit/bootstrap"
import { useShruti } from "@shruti/shruti.js"
import { bootstrapUserDatabaseFromApp } from "@shruti/services/bootstrap.js"
import { PREFERRED_SERVER_KEY } from "@shruti/services/preferredServer.js"
import { findRegion, getRegions, setRegions } from "@shruti/services/regionsRegistry.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { RemoteAppConfig } from "@lib/domain/config.js"

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

export type { BootstrapPhase as WelcomeViewState }

export interface WelcomeControllerOptions {
  navigateToRoute?: string
  autoNavigate?: boolean
}

export interface WelcomeControllerReturn {
  /** Coarse SWR lifecycle phase, bound by the status-message composable. */
  phase: Ref<BootstrapPhase>
  error: Ref<string | null>
  progress: Ref<number>
  isError: ComputedRef<boolean>
  /** Show the welcome screen only when this launch has no usable local DB. */
  showWelcomeScreen: ComputedRef<boolean>
  onRetry: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/*                                 Controller                                 */
/* -------------------------------------------------------------------------- */

/**
 * Drives Shruti startup via the generic kit Stale-While-Revalidate
 * orchestrator (`@kit/bootstrap`). All the resolve / probe / scheme-retry /
 * background-refresh logic now lives in kit; this controller only injects the
 * Shruti-specific ports (composition root, region registry, preferences)
 * and handles navigation.
 */
export function useWelcomeController(
  options: WelcomeControllerOptions = {}
): WelcomeControllerReturn {
  const { navigateToRoute = "/tabs/home", autoNavigate = true } = options

  const ionRouter = useIonRouter()
  const shruti = useShruti()

  /**
   * Adopt a freshly-fetched `regions` block: replace + persist the runtime
   * region list, then re-point the active server. Same id → picks up the new
   * endpoints; a removed active region → falls back to the first region. An
   * empty/invalid block is ignored.
   */
  function applyRemoteRegions(config: RemoteAppConfig): void {
    if (!config.regions) return
    if (!setRegions(config.regions)) return
    const activeId = shruti.activeServer.value.id
    const targetId = findRegion(activeId) ? activeId : getRegions()[0]!.id
    shruti.setActiveServerById(targetId)
  }

  /**
   * Build the kit resolver options. The probe is adapted to the kit
   * `ProbeFn` shape (server + config); region adoption + active-server
   * re-pointing ride along via the resolved callbacks.
   */
  function buildResolveOptions(
    incompatibleDbPaths: ReadonlySet<string>
  ): ResolveContentDatabaseOptions<RemoteAppConfig> {
    return {
      store: shruti.databaseFetcher,
      probe: async (configPath, preferredServerId) => {
        const result = await shruti.serverProber.probe(
          configPath,
          preferredServerId ?? undefined
        )
        return {
          server: findRegion(result.serverId) ?? getRegions()[0]!,
          config: result.config as RemoteAppConfig,
        } satisfies ProbeResult<RemoteAppConfig>
      },
      configPath: shruti.appConfig.publicRemoteConfigPath,
      remotePathTemplate: shruti.appConfig.database.remotePathTemplate,
      localPathTemplate: shruti.appConfig.database.localPathTemplate,
      supportedScheme: SUPPORTED_DB_SCHEME,
      incompatibleDbPaths,
      preferredServerId: shruti.activeServer.value.id,
      onServerResolved: (probe) => shruti.setActiveServerById(probe.server.id),
      onConfigResolved: applyRemoteRegions,
    }
  }

  const controller = createBootstrapController<RemoteAppConfig, unknown>({
    supportedScheme: SUPPORTED_DB_SCHEME,
    buildResolveOptions,
    openContentDatabase: (path) => shruti.openContentDatabase(path),
    closeContentDatabase: () => shruti.closeContentDatabase(),
    readContentSchemeVersion: () => shruti.readContentSchemeVersion(),
    deleteLocalDatabase: (path) => shruti.databaseFetcher.delete(path),
    invalidateConfigCache: () =>
      shruti.filesStorage.delete(
        shruti.storagePublicUrl.get(shruti.appConfig.publicRemoteConfigPath)
      ),
    // Phase 3 of startup: open the user DB + run pending user migrations.
    runUserDatabaseMigrations: () => bootstrapUserDatabaseFromApp(shruti),
    // Best-effort background refresh: persist the winning preferred server so
    // the next cold start lands on the same region.
    onBackgroundRefreshComplete: () => {
      void shruti.preferences.set(PREFERRED_SERVER_KEY, shruti.activeServer.value.id)
    },
    onBackgroundRefreshError: (err) => {
      console.warn("[shruti] background content refresh failed:", err)
    },
  })

  /**
   * Pre-hydrate everything HomeView reads on mount (playlist, content-DB
   * dictionaries, and the persisted UI-language setting) so the first paint
   * of Home is already populated instead of reflowing once these arrive a
   * tick later. Best-effort: a slow or failed load must never strand the
   * user on Welcome, so any error is logged and we navigate regardless.
   */
  async function prewarmHome(): Promise<void> {
    const playlist = usePlaylistStore()
    const dictionaries = useDictionariesStore()
    // Touch the app-language ref so its async hydration starts, then await
    // the same preference read it performs internally — settling the ref
    // before Home's dictionary labels render in the wrong sort order.
    void useAppLanguage().value
    try {
      await Promise.all([
        playlist.ensureLoaded(),
        dictionaries.ensureLoaded(),
        shruti.preferences.get("settings.appLanguage"),
      ])
    } catch (err) {
      console.warn("[shruti] home pre-hydration failed:", err)
    }
  }

  // Flips true the instant we hand off to Home. Until then the welcome
  // splash stays up — including the cache-hit fast path and the prewarm
  // wait — so the user never sees a blank page while content loads.
  const navigated = ref(false)

  async function initialize(): Promise<void> {
    navigated.value = false
    await controller.start()
    if (controller.isReady.value && autoNavigate) {
      await prewarmHome()
      navigated.value = true
      ionRouter.replace(navigateToRoute, crossfadeAnimation)
    }
  }

  // Keep the welcome splash visible for the whole startup — DB resolve /
  // download / migration, AND the prewarm of Home's data — until we actually
  // navigate. The blank `<IonPage>` then shows only during the crossfade out.
  // (Previously the cache-hit path entered silently, exposing a blank page for
  // the seconds prewarmHome now takes.)
  const showWelcomeScreen = computed(() => !navigated.value)

  onMounted(() => {
    void initialize()
  })

  return {
    phase: controller.phase,
    error: controller.error,
    progress: controller.progress,
    isError: controller.isError,
    showWelcomeScreen,
    onRetry: initialize,
  }
}
