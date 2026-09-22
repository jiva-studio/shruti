// kit/infra — framework-agnostic infrastructure adapters.

// IndexedDB key-value blob store.
export {
  openDatabase,
  closeDatabase,
  saveBlob,
  saveData,
  getBlob,
  deleteBlob,
  keyExists,
  getAllKeys,
  getStorageInfo,
} from "./idbKv.js"

// Preferences — string key-value store for lightweight settings.
export type { IPreferences } from "./preferences/preferences.js"
export { useCapacitorPreferences } from "./preferences/capacitorPreferences.js"

// Remote files storage — fetch-on-miss, cache-to-disk, stale-while-revalidate.
export { type IRemoteFilesStorage, urlToCacheKey } from "./files/remoteFilesStorage.js"
export { type IJsonRemoteStorage, createJsonRemoteStorage } from "./files/jsonRemoteStorage.js"
export { useWebRemoteFilesStorage } from "./files/webRemoteFilesStorage.js"
export {
  useCapacitorRemoteFilesStorage,
  cachePathFor,
} from "./files/capacitorRemoteFilesStorage.js"

// Storage public URL resolver.
export type { IStoragePublicUrl } from "./storagePublicUrl/storagePublicUrl.js"
export { useStoragePublicUrl } from "./storagePublicUrl/useStoragePublicUrl.js"

// Database transfer (export/import user DB).
export type { IDatabaseTransfer } from "./databaseTransfer/databaseTransfer.js"
export {
  useCapacitorDatabaseTransfer,
  type CapacitorDatabaseTransferOptions,
} from "./databaseTransfer/capacitorDatabaseTransfer.js"
export {
  useWebDatabaseTransfer,
  type WebDatabaseTransferOptions,
} from "./databaseTransfer/webDatabaseTransfer.js"

// Share — native share sheet + clipboard.
export type { IShareService, ShareOptions } from "./share/share.js"
export { useCapacitorShareService } from "./share/capacitorShare.js"

// Haptics — physical impact feedback.
export type { IHaptics, HapticImpactStyle } from "./haptics/haptics.js"
export { useCapacitorHaptics } from "./haptics/capacitorHaptics.js"
export { useWebHaptics } from "./haptics/webHaptics.js"

// Notifications — local (on-device) scheduler.
export type {
  INotificationScheduler,
  ScheduledNotification,
  NotificationPermission,
} from "./notifications/notifications.js"
export { NotificationsDisabledError } from "./notifications/notifications.js"
export { useCapacitorNotificationScheduler } from "./notifications/capacitorNotifications.js"
