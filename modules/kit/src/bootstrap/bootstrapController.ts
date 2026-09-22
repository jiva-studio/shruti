/**
 * Stale-While-Revalidate startup orchestrator for the content database.
 *
 * Decision (the whole point of this module):
 *  - If a compatible local content DB already exists → open it and enter the
 *    app IMMEDIATELY (no welcome screen). Then, in the BACKGROUND, probe the
 *    CDN for a newer compatible DB and download it for the NEXT launch. User
 *    migrations run before entering.
 *  - If NO usable local DB (first launch / none compatible) → surface the
 *    welcome phase, download the DB in the FOREGROUND with progress, validate
 *    the scheme, run migrations, then enter.
 *
 * Framework-light: exposes Vue `ref`s for reactive consumption, but holds no
 * app domain, no router, no i18n. Everything app-specific is an injected port.
 */
import { ref, computed, type Ref, type ComputedRef } from "vue"
import {
  downloadFromCdn,
  findLocalDatabaseVersion,
  pruneContentDatabases,
  buildVersionedPath,
  deriveParentDir,
  type RemoteContentConfig,
  type ResolveContentDatabaseOptions,
} from "./contentDatabaseResolver.js"
import {
  openAndValidateContentDatabase,
  isSchemeCompatible,
  type OpenAndValidateOptions,
} from "./schemeValidation.js"

/* -------------------------------------------------------------------------- */
/*                                   Phases                                   */
/* -------------------------------------------------------------------------- */

/**
 * Coarse lifecycle phase the UI binds to.
 *  - `idle`               — not started.
 *  - `ready`              — DB open + migrations done; app may enter.
 *  - `welcome:checking`   — first-launch probe before download begins.
 *  - `welcome:downloading`— first-launch foreground download (progress valid).
 *  - `welcome:migrations` — first-launch user-DB migrations.
 *  - `error`              — fatal; `onRetry` re-runs.
 */
export type BootstrapPhase =
  | "idle"
  | "ready"
  | "welcome:checking"
  | "welcome:downloading"
  | "welcome:migrations"
  | "error"

/* -------------------------------------------------------------------------- */
/*                                Injected ports                              */
/* -------------------------------------------------------------------------- */

export interface BootstrapControllerOptions<TConfig extends RemoteContentConfig, TDb> {
  supportedScheme: number

  /** Build the resolver options for an attempt; receives the per-session
   *  reject set. Used for both foreground resolve+validate and the
   *  background refresh. The same templates/probe/store live here. */
  buildResolveOptions: (
    incompatibleDbPaths: ReadonlySet<string>
  ) => ResolveContentDatabaseOptions<TConfig>

  /** Open the content DB at `path`. */
  openContentDatabase: (path: string) => Promise<TDb>
  /** Close the open content DB. */
  closeContentDatabase: () => Promise<void>
  /** Read the open content DB's scheme version. */
  readContentSchemeVersion: () => Promise<number>
  /** Drop a known-bad local content DB file. */
  deleteLocalDatabase: (path: string) => Promise<void>
  /** Drop the cached remote config (re-probe next attempt). Optional. */
  invalidateConfigCache?: () => Promise<void>

  /** Open the user DB + run pending user migrations. Runs before `ready`. */
  runUserDatabaseMigrations: () => Promise<void>

  /** Max scheme-mismatch retries. Default 3. */
  maxRetries?: number

  /** Called with the superseded DB paths dropped after a successful open. */
  onPrune?: (deletedPaths: readonly string[]) => void

  /** Called when a background refresh downloads a newer DB (for diagnostics
   *  / persisting the winning server). Optional. */
  onBackgroundRefreshComplete?: (downloadedNewVersion: boolean) => void
  /** Called when the background refresh fails. Default: console.warn. */
  onBackgroundRefreshError?: (error: unknown) => void
}

/* -------------------------------------------------------------------------- */
/*                                  Returned                                  */
/* -------------------------------------------------------------------------- */

export interface BootstrapController<TDb> {
  phase: Ref<BootstrapPhase>
  /** Download progress 0–1; meaningful during `welcome:downloading`. */
  progress: Ref<number>
  error: Ref<string | null>
  /** The opened, validated content DB; null until `ready`. */
  database: Ref<TDb | null>
  /** `true` once the app may enter (DB open + migrations done). */
  isReady: ComputedRef<boolean>
  /** `true` while the welcome screen should be shown. */
  isWelcome: ComputedRef<boolean>
  isError: ComputedRef<boolean>
  /** `true` when this launch found a usable local DB (instant start). */
  startedFromCache: Ref<boolean>
  /** Run the SWR startup. Resolves once the app may enter (`ready`). */
  start: () => Promise<void>
  /** Re-run after an error. */
  retry: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/*                              Implementation                               */
/* -------------------------------------------------------------------------- */

export function createBootstrapController<TConfig extends RemoteContentConfig, TDb>(
  opts: BootstrapControllerOptions<TConfig, TDb>
): BootstrapController<TDb> {
  const phase = ref<BootstrapPhase>("idle")
  const progress = ref(0)
  const error = ref<string | null>(null)
  const database = ref(null) as Ref<TDb | null>
  const startedFromCache = ref(false)

  const isReady = computed(() => phase.value === "ready")
  const isError = computed(() => phase.value === "error")
  const isWelcome = computed(() => phase.value.startsWith("welcome:"))

  /** Probe the local store for a usable, scheme-acceptable cached version. */
  async function findUsableLocalVersion(): Promise<number | null> {
    const resolveOpts = opts.buildResolveOptions(new Set<string>())
    const parentDir = deriveParentDir(resolveOpts.localPathTemplate)
    let files: string[]
    try {
      files = await resolveOpts.store.list(parentDir)
    } catch {
      return null
    }
    return findLocalDatabaseVersion(
      files,
      parentDir,
      resolveOpts.localPathTemplate,
      new Set<string>()
    )
  }

  function buildValidateOptions(
    seedRejectedPaths?: Iterable<string>
  ): OpenAndValidateOptions<TConfig, TDb> {
    return {
      seedRejectedPaths,
      buildResolveOptions: (incompatible) => {
        const base = opts.buildResolveOptions(incompatible)
        return {
          ...base,
          incompatibleDbPaths: incompatible,
          onPhase: (p) => {
            // Map resolver phases to coarse bootstrap phases. Only relevant
            // in the foreground (welcome) path.
            if (p === "database:downloading") phase.value = "welcome:downloading"
            else if (phase.value !== "welcome:downloading") phase.value = "welcome:checking"
          },
          onProgress: (received, total) => {
            // Normalised 0–1 fraction so the UI can bind it straight to a
            // determinate progress bar (`IonProgressBar`'s `value` is 0–1).
            progress.value = total > 0 ? received / total : 0
            base.onProgress?.(received, total)
          },
        }
      },
      supportedScheme: opts.supportedScheme,
      openDatabase: opts.openContentDatabase,
      closeDatabase: opts.closeContentDatabase,
      readSchemeVersion: opts.readContentSchemeVersion,
      deleteLocalDatabase: opts.deleteLocalDatabase,
      invalidateConfigCache: opts.invalidateConfigCache,
      maxRetries: opts.maxRetries,
    }
  }

  /**
   * Fire-and-forget background refresh: probe the CDN, download a newer
   * compatible DB for the NEXT launch. Best-effort — failures never surface.
   */
  function scheduleBackgroundRefresh(): void {
    void (async () => {
      try {
        const base = opts.buildResolveOptions(new Set<string>())
        // Skip the download in downloadFromCdn if the target version is
        // already on disk (store.exists guards that). Re-run from probe so a
        // newer published version is picked up.
        const before = await findUsableLocalVersion()
        const result = await downloadFromCdn({
          ...base,
          // No phase/progress wiring — must not touch the (already-entered) UI.
          onPhase: undefined,
          onProgress: undefined,
        })
        const downloadedNew = !result.fromCache && result.version !== before
        opts.onBackgroundRefreshComplete?.(downloadedNew)
      } catch (err) {
        if (opts.onBackgroundRefreshError) opts.onBackgroundRefreshError(err)
        else console.warn("[kit/bootstrap] background content refresh failed:", err)
      }
    })()
  }

  /**
   * Drop every cached DB older than the one we just opened. Content DBs are
   * tens of megabytes each, and without this every published catalog leaves
   * another dead copy on disk until uninstall.
   */
  async function pruneSuperseded(openVersion: number): Promise<void> {
    try {
      const resolveOpts = opts.buildResolveOptions(new Set<string>())
      const deleted = await pruneContentDatabases(
        resolveOpts.store,
        resolveOpts.localPathTemplate,
        openVersion
      )
      if (deleted.length > 0) opts.onPrune?.(deleted)
    } catch (err) {
      console.warn("[kit/bootstrap] pruning superseded content databases failed:", err)
    }
  }

  /**
   * Outcome of the fast path's attempt on a cached file. `corrupt` is the only
   * verdict that justifies unlinking tens of megabytes of catalog.
   */
  type CachedOpen =
    | { readonly status: "opened"; readonly db: TDb; readonly scheme: number }
    /** Failed the store's integrity check: the bytes are not a database. */
    | { readonly status: "corrupt" }
    /** The open threw on a file whose bytes check out — a stale connection, a
     *  rejected path resolution. Retryable, and not grounds for a delete. */
    | { readonly status: "transient" }

  /**
   * Open a cached file and read its scheme. `list()` proves a name, not bytes,
   * so the store's integrity gate runs first: without it a truncated download
   * becomes a permanent error screen, because `retry` re-picks the same file.
   */
  async function openCached(localPath: string): Promise<CachedOpen> {
    const resolveOpts = opts.buildResolveOptions(new Set<string>())
    const intact = await resolveOpts.store.exists(localPath).catch(() => false)
    if (!intact) return { status: "corrupt" }
    try {
      const db = await opts.openContentDatabase(localPath)
      const scheme = await opts.readContentSchemeVersion()
      return { status: "opened", db, scheme }
    } catch (err) {
      console.warn("[kit/bootstrap] cached content database failed to open:", err)
      await opts.closeContentDatabase().catch(() => undefined)
      return { status: "transient" }
    }
  }

  async function runUserMigrationsThenReady(): Promise<void> {
    phase.value = "welcome:migrations"
    await opts.runUserDatabaseMigrations()
    phase.value = "ready"
  }

  async function start(): Promise<void> {
    error.value = null
    progress.value = 0

    try {
      phase.value = "welcome:checking"
      const localVersion = await findUsableLocalVersion()
      const rejectedFromFastPath = new Set<string>()

      if (localVersion !== null) {
        /* -- Fast path: open cached DB, enter immediately ------------------ */
        const resolveOpts = opts.buildResolveOptions(new Set<string>())
        const localPath = buildVersionedPath(resolveOpts.localPathTemplate, localVersion)
        const opened = await openCached(localPath)

        if (opened.status === "opened" && isSchemeCompatible(opened.scheme, opts.supportedScheme)) {
          database.value = opened.db
          startedFromCache.value = true
          await pruneSuperseded(localVersion)
          // Migrations run before entering; the cached DB is already usable.
          await opts.runUserDatabaseMigrations()
          phase.value = "ready"
          // Background: pull a newer DB for next launch.
          scheduleBackgroundRefresh()
          return
        }

        // Corrupt, or a scheme this build can't read — close + drop it, and
        // remember it as rejected so the foreground re-scan below never picks
        // it again (belt-and-braces with the delete, which is a no-op on some
        // adapters). The resolver then falls back to an older valid cache
        // before it reaches for the network.
        //
        // A transient open failure gets neither: the bytes passed the integrity
        // gate, so the file is worth keeping. The resolver re-picks it, and the
        // validate loop is what finally drops it if it fails there too.
        if (opened.status !== "transient") {
          if (opened.status === "opened") await opts.closeContentDatabase().catch(() => undefined)
          await opts.deleteLocalDatabase(localPath).catch(() => undefined)
          rejectedFromFastPath.add(localPath)
        }
      }

      /* -- Slow path: foreground download + validate -------------------- */
      startedFromCache.value = false
      phase.value = "welcome:checking"
      const validated = await openAndValidateContentDatabase(
        buildValidateOptions(rejectedFromFastPath)
      )
      database.value = validated.database
      await pruneSuperseded(validated.result.version)
      await runUserMigrationsThenReady()
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to initialize"
      phase.value = "error"
      console.error("[kit/bootstrap] startup failed:", err)
    }
  }

  return {
    phase,
    progress,
    error,
    database,
    isReady,
    isWelcome,
    isError,
    startedFromCache,
    start,
    retry: start,
  }
}
