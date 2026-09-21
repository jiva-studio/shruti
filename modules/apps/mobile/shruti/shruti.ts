import { createJsonRemoteStorage } from "@kit/infra"
import { createStallGuard } from "@infra/watchDownload.js"
import { ref, watch } from "vue"
import { type CdnServer } from "@lib/domain/servers.js"
import type { AppRepositories } from "./repositories.js"
import type { Shruti, InitShrutiSeed } from "@shruti/services/shrutiTypes.js"
import { findRegion, setActiveRegionId } from "./services/regionsRegistry.js"
import { PREFERRED_SERVER_KEY } from "./services/preferredServer.js"
import type { IStoragePublicUrl } from "@ports/app/index.js"
import { createAppRepositories } from "./repositories.js"
import { createOwnerIdProvider } from "./syncOwner.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useSyncChatsEnabled } from "@shruti/composables/useSyncChats.js"
import { useStoragePublicUrl } from "@kit/infra"
import { useHttpShareAudioService } from "@infra/shareAudio/http/useHttpShareAudioService.js"
import { useHttpShareVideoService } from "@infra/shareVideo/http/useHttpShareVideoService.js"
import { useHttpShareTranscriptService } from "@infra/shareTranscript/http/useHttpShareTranscriptService.js"
import { createSqlSchemeVersionRepository } from "@infra/repositories/sql/index.js"
import { createHttpChatStreamClient } from "@infra/chat/http/httpChatStreamClient.js"
import { createHttpChatTitleService } from "@infra/chat/http/httpChatTitleService.js"
import { createHttpChatQuestionsService } from "@infra/chat/http/httpChatQuestionsService.js"
import { createHttpChatFeedbackService } from "@infra/chat/http/httpChatFeedbackService.js"
import { createHttpChatResumeService } from "@infra/chat/http/httpChatResumeService.js"

export type { AppConfig, Shruti, InitShrutiSeed } from "@shruti/services/shrutiTypes.js"

let instance: Shruti | null = null

export function initShruti(seed: InitShrutiSeed): Shruti {
  if (instance) throw new Error("Shruti already initialized")

  const activeServer = ref<CdnServer>(seed.initialServer)
  // Mirror the active region into the registry so resolveAssetUrl (covers,
  // avatars) builds against the live region, not a hardcoded regions[0].
  setActiveRegionId(seed.initialServer.id)
  // Whenever activeServer flips, persist the id under PREFERRED_SERVER_KEY
  // so the next cold start lands on the same region. This collapses the
  // "set active" and "remember for next launch" knobs that used to live
  // as two separate functions (setActiveServerById + promotePreferredServer)
  // and caused subtle regressions whenever a new flow forgot to call both.
  // Welcome's initial swap doesn't need an early-exit guard: writing the
  // same id back to preferences is a no-op on disk.
  watch(activeServer, (next, prev) => {
    // Keep asset resolution pointed at the live region on every promotion.
    setActiveRegionId(next.id)
    if (next.id === prev.id) return
    void seed.preferences.set(PREFERRED_SERVER_KEY, next.id).catch((err) => {
      console.warn(`[shruti] persist preferredServerId failed for ${next.id}`, err)
    })
  })
  const contentDbFile = ref<string | null>(null)
  const databases: Shruti["databases"] = { content: null, user: null }
  let cachedRepos: AppRepositories | null = null

  // Owner of every journaled row. Lives out here, not inside `repositories()`,
  // so the last-seen identity survives a repository rebuild.
  const getOwnerId = createOwnerIdProvider(() => seed.auth.getSession()?.userId ?? null)

  // `useStoragePublicUrl` is the canonical adapter — a thin
  // `{path}`-substitution function. We feed it a getter closure so
  // the resolver always sees the latest CDN template after
  // `setActiveServer` swaps it.
  const storagePublicUrl: IStoragePublicUrl = useStoragePublicUrl(() => activeServer.value)

  // Same lazy-getter pattern as storagePublicUrl: resolves the
  // per-region cutter endpoint at call time, so a settings flip
  // routes subsequent share-audio calls to the new region.
  //
  // share-video also requires a Bearer token (per-user daily quota
  // enforced server-side). share-audio stays anonymous — its work is
  // cheap stream-copy, only Caddy edge rate-limit applies.
  const shareAudioService = useHttpShareAudioService(() => activeServer.value.shareAudioUrl)
  const shareVideoService = useHttpShareVideoService(
    () => activeServer.value.shareVideoUrl,
    () => seed.auth.getAccessToken()
  )
  // share-transcript base. A published config.json predating the field
  // omits it — derive from chatBaseUrl (share-* routes live behind the
  // same Caddy as chat) so old configs keep working.
  const shareTranscriptService = useHttpShareTranscriptService(
    () =>
      activeServer.value.shareTranscriptUrl ?? `${activeServer.value.chatBaseUrl}/share/transcripts`
  )

  // Chat service adapters. Built here (not in the chat store) so the
  // composition root stays the only place that knows concrete @infra
  // adapters. `chatAuthDeps` closes over the failover-aware HTTP client
  // and the auth token getter.
  const chatAuthDeps = {
    getAccessToken: () => seed.auth.getAccessToken(),
    request: seed.chatHttpRequest,
  }
  const chatStreamClient = createHttpChatStreamClient(chatAuthDeps)
  const chatTitleService = createHttpChatTitleService(chatAuthDeps)
  const chatQuestionsService = createHttpChatQuestionsService(chatAuthDeps)
  const chatFeedbackService = createHttpChatFeedbackService(chatAuthDeps)
  const chatResumeService = createHttpChatResumeService(chatAuthDeps)

  const self: Shruti = {
    appConfig: seed.appConfig,
    persistence: seed.persistence,
    databaseFetcher: seed.databaseFetcher,
    filesStorage: seed.filesStorage,
    remoteJson: createJsonRemoteStorage(seed.filesStorage),
    createStallGuard,
    storagePublicUrl,
    preferences: seed.preferences,
    preferenceKeys: seed.preferenceKeys,
    audioPlayer: seed.audioPlayer,
    notifications: seed.notifications,
    shareService: seed.shareService,
    shareAudioService,
    shareVideoService,
    shareTranscriptService,
    excerptCache: seed.excerptCache,
    haptics: seed.haptics,
    mediaDownloader: seed.mediaDownloader,
    purchases: seed.purchases,
    serverProber: seed.serverProber,
    auth: seed.auth,
    chatHttpRequest: seed.chatHttpRequest,
    proactiveChat: seed.proactiveChat,
    chatStreamClient,
    chatTitleService,
    chatQuestionsService,
    chatFeedbackService,
    chatResumeService,
    syncClient: seed.syncClient,
    ingestClient: seed.ingestClient,
    discoveryClient: seed.discoveryClient,
    getDeviceId: seed.getDeviceId,
    databaseTransfer: seed.databaseTransferFactory(() => databases.user),
    platform: seed.platform,
    activeServer,
    contentDbFile,
    databases,

    setActiveServer(server) {
      activeServer.value = server
    },

    setActiveServerById(serverId) {
      const server = findRegion(serverId)
      if (!server) throw new Error(`Unknown server id: ${serverId}`)
      activeServer.value = server
    },

    async openContentDatabase(path) {
      if (databases.content) await databases.content.close()
      const db = await seed.persistence.open(path)
      databases.content = db
      // Basename for display (Settings build-info line).
      const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
      contentDbFile.value = idx >= 0 ? path.substring(idx + 1) : path
      return db
    },

    async closeContentDatabase() {
      if (databases.content) {
        await databases.content.close()
        databases.content = null
      }
    },

    async openUserDatabase(path) {
      if (databases.user) return databases.user
      const db = await seed.persistence.open(path)
      databases.user = db
      return db
    },

    async closeUserDatabase() {
      const db = databases.user
      databases.user = null
      // Repositories close over the handle we just dropped; the next
      // `repositories()` must rebuild rather than serve the dead one.
      cachedRepos = null
      if (db) await db.close()
    },

    repositories() {
      if (cachedRepos) return cachedRepos
      if (!databases.content) {
        throw new Error("repositories(): content DB is not open yet")
      }
      if (!databases.user) {
        throw new Error("repositories(): user DB is not open yet")
      }
      const appLanguage = useAppLanguage()
      // Device-local "Sync chats" toggle (default ON); read live so a flip in
      // Settings gates the very next chat write without rebuilding repos.
      const syncChatsEnabled = useSyncChatsEnabled()
      cachedRepos = createAppRepositories({
        contentDb: databases.content,
        userDb: databases.user,
        filesStorage: seed.filesStorage,
        storagePublicUrl,
        getActiveLanguage: () => appLanguage.value,
        // Turns on the sync-journal decorator + the engine repositories.
        getDeviceId: seed.getDeviceId,
        // Read off the auth port, not the store: the port is the source the
        // store mirrors, so a row journaled during an account switch is
        // stamped with the identity actually in effect. Sticky across the
        // session-less window `signOut` / `deleteAccount` open — see
        // createOwnerIdProvider.
        getOwnerId,
        isChatSyncEnabled: () => syncChatsEnabled.value,
      })
      return cachedRepos
    },

    async readContentSchemeVersion() {
      if (!databases.content) {
        throw new Error("readContentSchemeVersion(): content DB is not open yet")
      }
      return createSqlSchemeVersionRepository(databases.content).read()
    },
  }

  instance = self
  return self
}

export function useShruti(): Shruti {
  if (!instance) throw new Error("Shruti not initialized — call initShruti first")
  return instance
}

export function isShrutiInitialized(): boolean {
  return instance !== null
}

/** Test-only hook: resets the singleton between test cases. */
export function __resetShrutiForTests(): void {
  instance = null
}
