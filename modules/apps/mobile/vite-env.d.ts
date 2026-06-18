/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Opt-in flag (`"true"`) that injects the local-dev region — set by the
   *  `local-stack` skill when serving against the local backend stack. */
  readonly VITE_DEV_REGION?: string
  /** Override the local-dev region's auth base URL (default http://localhost:11081/auth). */
  readonly VITE_DEV_AUTH_URL?: string
  /** Override the local-dev region's chat base URL (default http://localhost:11080). */
  readonly VITE_DEV_CHAT_URL?: string
}

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __BUILD_ID__: string
declare const __COMMIT_SHA__: string
declare const __DB_SCHEME__: number
declare const __REVENUECAT_IOS_KEY__: string
declare const __REVENUECAT_ANDROID_KEY__: string
declare const __GOOGLE_WEB_CLIENT_ID__: string
declare const __GOOGLE_IOS_CLIENT_ID__: string
declare const __SENTRY_DSN__: string
declare const __SENTRY_RELEASE__: string
