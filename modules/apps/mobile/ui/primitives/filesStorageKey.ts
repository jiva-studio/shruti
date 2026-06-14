import type { InjectionKey } from "vue"
import type { IRemoteFilesStorage } from "@kit/infra"

/**
 * Provided by the composition root (App.vue) so UI can resolve cached image
 * URLs (CachedImage / AuthorAvatar) without importing the composition root.
 */
export const FILES_STORAGE_KEY: InjectionKey<IRemoteFilesStorage> = Symbol("filesStorage")
