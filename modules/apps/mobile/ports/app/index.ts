export type {
  IDatabase,
  IPersistence,
  IDatabaseFetcher,
  ProgressCallback,
  QueryValue,
  QueryParams,
} from "./persistence.js"
export type { IRemoteFilesStorage } from "./files.js"
export type { IStoragePublicUrl } from "./storagePublicUrl.js"
export type { IPreferences } from "./preferences.js"
export type { ISchemeVersionRepository } from "./schemeVersion.js"
export type {
  IAudioPlayer,
  AudioOpenParams,
  AudioStatus,
  AudioProgressListener,
} from "./audioPlayer.js"
export type { IMediaDownloader } from "./mediaDownloader.js"
export type { INotificationScheduler, ScheduledNotification } from "./notifications.js"
export type { IShareService, ShareOptions } from "./share.js"
export type { IHaptics, HapticImpactStyle } from "./haptics.js"
export type { IServerProber, ServerProbeResult } from "./serverProber.js"
export type { IDatabaseTransfer } from "./databaseTransfer.js"
export type { IShareAudioService, CutExcerptRequest, CutExcerptResponse } from "./shareAudio.js"
export type { IShareVideoService, CutVideoRequest, CutVideoResponse } from "./shareVideo.js"
export type { IExcerptCache } from "./excerptCache.js"
export type {
  IPurchases,
  PurchasePackage,
  CustomerState,
  CustomerInfoListener,
} from "./purchases.js"
export { PurchaseCancelledError } from "./purchases.js"
export type { AuthPort, AuthSession, AuthStatus, AuthConfig } from "./auth.js"

// The chat SSE protocol contracts (IChatStreamClient, IChatTitleService,
// IChatQuestionsService, IProactiveChatService, IChatFeedbackService and
// their wire types) now live in @lib/contracts — the dependency-free
// shared-kernel layer — so the chat use case can import them without
// breaking the application→domain-only rule. Import them from there.
