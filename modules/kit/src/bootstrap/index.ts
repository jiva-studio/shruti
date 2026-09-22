// kit/bootstrap — generic Stale-While-Revalidate startup orchestrator for the
// content database, plus the offline-first resolver and scheme validation it
// builds on. Framework-light (Vue refs only); no app domain, router or i18n.
export {
  resolveContentDatabase,
  downloadFromCdn,
  NoCompatibleDatabaseError,
  findLatestCompatibleVersion,
  findLocalDatabaseVersion,
  pruneContentDatabases,
  deriveParentDir,
  buildVersionedPath,
  type ContentDatabaseStore,
  type DownloadProgress,
  type ResolvedServer,
  type ProbeResult,
  type ProbeFn,
  type RemoteContentConfig,
  type ResolverPhase,
  type ResolveContentDatabaseOptions,
  type ResolveResult,
} from "./contentDatabaseResolver.js"

export {
  openAndValidateContentDatabase,
  isSchemeCompatible,
  type OpenAndValidateOptions,
  type OpenAndValidateResult,
} from "./schemeValidation.js"

export {
  createBootstrapController,
  type BootstrapPhase,
  type BootstrapController,
  type BootstrapControllerOptions,
} from "./bootstrapController.js"
