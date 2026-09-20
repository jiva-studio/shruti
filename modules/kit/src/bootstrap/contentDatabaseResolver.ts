/**
 * Generic content-database resolver — the offline-first "pick a usable DB
 * file" step shared by every akdasa app's startup flow.
 *
 * The flow is identical across apps:
 *   1. Scan the local database directory for a cached file (offline-first).
 *      If one exists (and isn't on the per-session reject list), use it —
 *      no network.
 *   2. Otherwise probe the CDN pool for the remote config manifest, pick
 *      the latest version compatible with this build's scheme, and download
 *      it (with progress).
 *
 * Everything app-specific (file naming, URL templates, the probe + fetch
 * adapters) is injected. No project names, no Vue, no router here.
 */

/* -------------------------------------------------------------------------- */
/*                              Injected ports                                */
/* -------------------------------------------------------------------------- */

/** Progress callback: bytes received / total (total may be 0 if unknown). */
export type DownloadProgress = (receivedLength: number, totalLength: number) => void

/**
 * Storage-side adapter for cached database files. Matches the shape of the
 * apps' `IDatabaseFetcher` so existing adapters drop straight in.
 */
export interface ContentDatabaseStore {
  /** List cached DB file paths under `directory`. Empty when the directory
   *  doesn't exist or the adapter can't list (e.g. IndexedDB web adapter). */
  list(directory: string): Promise<string[]>
  /** Whether a cached DB already exists at `path`. */
  exists(path: string): Promise<boolean>
  /** Download `url` into `path`, reporting progress. */
  download(url: string, path: string, onProgress?: DownloadProgress): Promise<void>
  /** Remove a cached DB at `path`. No-op when absent. */
  delete(path: string): Promise<void>
}

/** Minimal server descriptor returned by a probe. */
export interface ResolvedServer {
  readonly id: string
  /** URL template carrying the host, with a single `{path}` placeholder. */
  readonly urlTemplate: string
}

/** Result of probing the CDN pool: the winning server + its config body. */
export interface ProbeResult<TConfig = unknown> {
  readonly server: ResolvedServer
  readonly config: TConfig
}

/** Probe the CDN pool for the remote config. */
export type ProbeFn<TConfig = unknown> = (
  configPath: string,
  preferredServerId?: string | null
) => Promise<ProbeResult<TConfig>>

/**
 * Remote-config minimum shape: a list of available database versions with
 * an optional scheme number. Apps may extend this freely.
 */
export interface RemoteContentConfig {
  readonly databases?: ReadonlyArray<{ readonly version: number; readonly scheme?: number }>
}

/* -------------------------------------------------------------------------- */
/*                                 Options                                    */
/* -------------------------------------------------------------------------- */

export type ResolverPhase =
  | "database:check"
  | "server:probing"
  | "config:downloading"
  | "database:downloading"

export interface ResolveContentDatabaseOptions<TConfig extends RemoteContentConfig> {
  store: ContentDatabaseStore
  probe: ProbeFn<TConfig>
  /** Remote config path (e.g. "public/config.json") — consumed verbatim. */
  configPath: string
  /** Remote DB path template with a single `{version}` placeholder. */
  remotePathTemplate: string
  /** Local storage path template with a single `{version}` placeholder. */
  localPathTemplate: string
  /** Scheme number this build understands; remote entries must match. */
  supportedScheme: number
  /** Paths rejected this session by scheme validation — skipped on rescan. */
  incompatibleDbPaths?: ReadonlySet<string>
  /** Sticky-winner hint; probed first when present. */
  preferredServerId?: string | null
  /** Invoked with the probe winner so the caller can persist/activate it. */
  onServerResolved?: (result: ProbeResult<TConfig>) => void
  /** Invoked with the freshly-fetched config (regions block, etc.). */
  onConfigResolved?: (config: TConfig) => void
  onProgress?: DownloadProgress
  onPhase?: (phase: ResolverPhase) => void
}

export interface ResolveResult {
  /** Local storage path of a usable DB file. */
  localPath: string
  /** Resolved DB version. */
  version: number
  /** `true` when satisfied from the local cache (no download). */
  fromCache: boolean
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** Parent directory of the version-templated local path (everything before
 *  the final `/`). Returns "" for a bare filename. */
export function deriveParentDir(localPathTemplate: string): string {
  const lastSlash = localPathTemplate.lastIndexOf("/")
  return lastSlash >= 0 ? localPathTemplate.slice(0, lastSlash) : ""
}

/** Substitute `{version}` in a template. */
export function buildVersionedPath(template: string, version: number): string {
  return template.replace("{version}", String(version))
}

/** Build a `\d+` matcher for cached files from the local path template. The
 *  template's filename portion (with `{version}` → a capture group) becomes
 *  the regex, so naming differences between apps need no extra config. */
function buildFileRegex(localPathTemplate: string): RegExp {
  const fileName = localPathTemplate.substring(localPathTemplate.lastIndexOf("/") + 1)
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp("^" + escaped.replace("\\{version\\}", "(\\d+)") + "$")
}

/** Latest compatible version from the remote config, or null when none. */
export function findLatestCompatibleVersion(
  config: RemoteContentConfig,
  supportedScheme: number
): number | null {
  const compatible = (config.databases ?? []).filter((db) => (db.scheme ?? 1) === supportedScheme)
  return compatible.length > 0 ? Math.max(...compatible.map((db) => db.version)) : null
}

/** Merge two path sets without mutating either (small, allocates per scan). */
function union(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (b.size === 0) return a
  const merged = new Set(a)
  for (const v of b) merged.add(v)
  return merged
}

/**
 * Delete cached content DBs, keeping only `keepVersion` and anything newer;
 * `null` keeps none (a full content-DB reset). Returns the deleted paths.
 *
 * Only files matching the template's version pattern are touched, so a
 * sibling in the same directory — a user DB, say — is never collateral.
 * Best-effort: a failed delete is skipped, not thrown.
 */
export async function pruneContentDatabases(
  store: Pick<ContentDatabaseStore, "list" | "delete">,
  localPathTemplate: string,
  keepVersion: number | null
): Promise<string[]> {
  const parentDir = deriveParentDir(localPathTemplate)
  let files: string[]
  try {
    files = await store.list(parentDir)
  } catch {
    return []
  }

  const re = buildFileRegex(localPathTemplate)
  const deleted: string[] = []
  for (const entry of files) {
    const name = entry.substring(entry.lastIndexOf("/") + 1)
    const m = re.exec(name)
    if (!m) continue
    if (keepVersion !== null && parseInt(m[1], 10) >= keepVersion) continue
    const path = parentDir ? `${parentDir}/${name}` : name
    try {
      await store.delete(path)
      deleted.push(path)
    } catch {
      // Locked or already gone — leave it for the next launch.
    }
  }
  return deleted
}

/** Latest cached version on disk (excluding rejected paths), or null. */
export function findLocalDatabaseVersion(
  files: readonly string[],
  parentDir: string,
  localPathTemplate: string,
  incompatibleDbPaths: ReadonlySet<string>
): number | null {
  const re = buildFileRegex(localPathTemplate)
  const versions: number[] = []
  for (const entry of files) {
    const name = entry.substring(entry.lastIndexOf("/") + 1)
    const fullPath = parentDir ? `${parentDir}/${name}` : name
    if (incompatibleDbPaths.has(fullPath) || incompatibleDbPaths.has(entry)) continue
    const m = re.exec(name)
    if (m) versions.push(parseInt(m[1], 10))
  }
  return versions.length > 0 ? Math.max(...versions) : null
}

/* -------------------------------------------------------------------------- */
/*                                  Resolve                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a usable local content-DB path: offline cache first, CDN probe +
 * download as a fallback. Pure orchestration over the injected ports.
 */
export async function resolveContentDatabase<TConfig extends RemoteContentConfig>(
  opts: ResolveContentDatabaseOptions<TConfig>
): Promise<ResolveResult> {
  const incompatible = opts.incompatibleDbPaths ?? new Set<string>()

  /* -- offline scan -------------------------------------------------------- */
  opts.onPhase?.("database:check")
  const parentDir = deriveParentDir(opts.localPathTemplate)
  const localFiles = await opts.store.list(parentDir)

  // `list()` only proves a file with a matching name is present, not that it is
  // a usable DB: an OS-killed mid-write download (Android WorkManager / MIUI
  // kill, low storage) leaves a truncated/corrupt file that still matches the
  // version regex. Validate each candidate via `store.exists()` (the adapter's
  // integrity-checking read) newest-first; a candidate that fails validation is
  // skipped this scan so the next-older valid cache — or, failing that, the CDN
  // — is used instead of surfacing a corrupt file as canonical.
  const rejectedThisScan = new Set<string>()
  for (;;) {
    const cachedVersion = findLocalDatabaseVersion(
      localFiles,
      parentDir,
      opts.localPathTemplate,
      union(incompatible, rejectedThisScan)
    )
    if (cachedVersion === null) break

    const localPath = buildVersionedPath(opts.localPathTemplate, cachedVersion)
    if (await opts.store.exists(localPath)) {
      return { localPath, version: cachedVersion, fromCache: true }
    }
    // Corrupt/truncated cached file — drop it so it is never reconsidered and
    // can't waste disk, then look for an older valid cache.
    await opts.store.delete(localPath).catch(() => undefined)
    rejectedThisScan.add(localPath)
  }

  /* -- CDN probe + download ------------------------------------------------ */
  return downloadFromCdn(opts)
}

/**
 * Thrown when the resolved remote config lists no database compatible with
 * this build's scheme. Typed so callers can distinguish "config has nothing
 * for me" (often a STALE cached config — drop it and re-probe) from a genuine
 * network/probe failure. Carries the scheme for diagnostics.
 */
export class NoCompatibleDatabaseError extends Error {
  readonly scheme: number
  constructor(scheme: number) {
    super(`No compatible content database for scheme ${scheme}`)
    this.name = "NoCompatibleDatabaseError"
    this.scheme = scheme
  }
}

/**
 * The CDN half of {@link resolveContentDatabase}, also reused directly by the
 * background refresh. Probes the pool, picks the latest compatible version,
 * downloads it if not already present.
 */
export async function downloadFromCdn<TConfig extends RemoteContentConfig>(
  opts: ResolveContentDatabaseOptions<TConfig>
): Promise<ResolveResult> {
  opts.onPhase?.("server:probing")
  const probeResult = await opts.probe(opts.configPath, opts.preferredServerId)
  opts.onServerResolved?.(probeResult)
  opts.onConfigResolved?.(probeResult.config)

  opts.onPhase?.("config:downloading")
  const latestVersion = findLatestCompatibleVersion(probeResult.config, opts.supportedScheme)
  if (latestVersion === null) {
    throw new NoCompatibleDatabaseError(opts.supportedScheme)
  }

  const localPath = buildVersionedPath(opts.localPathTemplate, latestVersion)
  const remotePath = buildVersionedPath(opts.remotePathTemplate, latestVersion)
  const remoteUrl = probeResult.server.urlTemplate.replace("{path}", remotePath)

  opts.onPhase?.("database:check")
  const alreadyDownloaded = await opts.store.exists(localPath)
  if (!alreadyDownloaded) {
    opts.onPhase?.("database:downloading")
    await opts.store.download(remoteUrl, localPath, opts.onProgress)
  }

  return { localPath, version: latestVersion, fromCache: false }
}
